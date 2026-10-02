/* =====================================================================
   SERVIÇOS FINANCEIROS — Módulo 4 (Retaguarda Financeira)
   Camada 6 (Serviços): lógica pura, sem tela. A UI fica em retaguarda.js.
     • OFX ........ leitura de extratos (OFX 1.x SGML e 2.x XML)
     • Contas ..... vínculo "de-para" entre o OFX e as contas cadastradas
     • DFC ........ classificação das transações e base de KPIs da DFC
     • IEO ........ Índice de Eficiência Operacional das lojas (100 pontos/mês)
     • Laudo ...... prompt e montagem do Laudo de Performance por IA
   Modelos de dados (coleções no banco):
     contasBancarias/<id>                 { apelido, banco, bancoNome, agencia, conta, digito, tipo, lojaId, ofxAcctId, ativa }
     extratos/<contaId>_<AAAA-MM>_<n>     { contaId, mes, parte, transacoes:[{id, data, valor, tipo, hist, doc, cat?}], saldo?, arquivos[] }
     dfc/<AAAA-MM>                        { mes, entradas, saidas, liquido, porGrupo{}, porCategoria{}, porConta{}, porDia{}, semRegra, atualizadoEm }
     config/dfc                           { regras:[{id, termos[], sentido, categoria}] }
     config/ieo                           { pontosIniciais, faixas{verde,vermelha}, prazoJustificativaDias, reincidenciaMinima, tipos[] }
     ieo_ocorrencias/<AAAA-MM>_<loja>     { mes, lojaId, itens:[{id, data, tipoId, descricao, lancadoPor}] }
     ieo_fechamentos/<AAAA-MM>            { mes, matriz, ranking[], fechadoEm, fechadoPor }
     ieo_laudos/<AAAA-MM>_<loja>          { texto, origem:'ia'|'automatico', dados, geradoEm, geradoPor }
     alertas/<AAAA-MM>_<loja>             { tipo:'ieo_vermelha', lojaId, mes, pontos, supervisor, criadoEm, cienteEm?, cientePor? }
   ===================================================================== */

/* ============================ OFX ============================ */
const OFX = {
  /** Decodifica o arquivo: UTF-8; se vier com caracteres inválidos, Windows-1252 (padrão de muitos bancos brasileiros). */
  decodificar(buf) {
    const utf = new TextDecoder('utf-8').decode(buf);
    return utf.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(buf) : utf;
  },
  /** Valor de uma tag folha — funciona em SGML (sem fechamento) e XML. */
  tag(bloco, nome) {
    const m = bloco.match(new RegExp('<' + nome + '>\\s*([^<\\r\\n]*)', 'i'));
    return m ? m[1].trim() : '';
  },
  blocos(txt, nome) {
    const re = new RegExp('<' + nome + '>([\\s\\S]*?)</' + nome + '>', 'gi'); const out = []; let m;
    while ((m = re.exec(txt))) out.push(m[1]);
    return out;
  },
  /** 20260915120000[-3:BRT] → 2026-09-15 */
  data(v) { const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; },
  /** Valores com ponto ou vírgula decimal ("-1.234,56" ou "-1234.56"). */
  valor(v) {
    let s = String(v || '').trim().replace(/\s/g, '');
    if (s.includes(',') && s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number(s); return isNaN(n) ? null : Math.round(n * 100) / 100;
  },
  hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); },

  /**
   * Lê o OFX e devolve um extrato por conta:
   * [{ conta:{bankId, branchId, acctId, acctType, cartao}, moeda, periodo:{inicio,fim}, saldo:{valor,data}, transacoes:[…] }]
   */
  ler(texto) {
    const corpo = texto.slice(Math.max(0, texto.search(/<OFX>/i)));
    if (!/<OFX>/i.test(corpo)) throw new Error('O arquivo não parece ser um OFX (tag <OFX> não encontrada).');
    const extratos = [];
    const processar = (bloco, cartao) => {
      const contaBloco = (cartao ? this.blocos(bloco, 'CCACCTFROM') : this.blocos(bloco, 'BANKACCTFROM'))[0] || bloco;
      const conta = { bankId: this.tag(contaBloco, 'BANKID'), branchId: this.tag(contaBloco, 'BRANCHID'), acctId: this.tag(contaBloco, 'ACCTID'), acctType: this.tag(contaBloco, 'ACCTTYPE') || (cartao ? 'CREDITCARD' : ''), cartao };
      const lista = this.blocos(bloco, 'BANKTRANLIST')[0] || bloco;
      const vistos = {};
      const transacoes = this.blocos(lista, 'STMTTRN').map(t => {
        const data = this.data(this.tag(t, 'DTPOSTED')), valor = this.valor(this.tag(t, 'TRNAMT'));
        const memo = this.tag(t, 'MEMO'), nome = this.tag(t, 'NAME');
        let id = this.tag(t, 'FITID');
        if (!id) { const base = `${data}|${valor}|${memo}|${nome}`; vistos[base] = (vistos[base] || 0) + 1; id = 'h' + this.hash(base + '#' + vistos[base]); }
        return { id, data, valor, tipo: this.tag(t, 'TRNTYPE').toUpperCase(), hist: [nome, memo].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ').slice(0, 120), doc: this.tag(t, 'CHECKNUM') || this.tag(t, 'REFNUM') };
      }).filter(t => t.data && t.valor != null && t.valor !== 0);
      const lb = this.blocos(bloco, 'LEDGERBAL')[0];
      extratos.push({
        conta, moeda: this.tag(bloco, 'CURDEF') || 'BRL',
        periodo: { inicio: this.data(this.tag(lista, 'DTSTART')), fim: this.data(this.tag(lista, 'DTEND')) },
        saldo: lb ? { valor: this.valor(this.tag(lb, 'BALAMT')), data: this.data(this.tag(lb, 'DTASOF')) } : null,
        transacoes,
      });
    };
    this.blocos(corpo, 'STMTRS').forEach(b => processar(b, false));
    this.blocos(corpo, 'CCSTMTRS').forEach(b => processar(b, true));
    if (!extratos.length) throw new Error('Nenhum extrato (STMTRS) encontrado no arquivo.');
    return extratos;
  },
};

/* ======================= CONTAS (de-para) ======================= */
const BANCOS = [
  ['001', 'Banco do Brasil'], ['004', 'Banco do Nordeste (BNB)'], ['033', 'Santander'], ['041', 'Banrisul'], ['077', 'Inter'], ['104', 'Caixa Econômica Federal'],
  ['208', 'BTG Pactual'], ['237', 'Bradesco'], ['260', 'Nubank'], ['336', 'C6 Bank'], ['341', 'Itaú Unibanco'], ['422', 'Safra'],
  ['748', 'Sicredi'], ['756', 'Sicoob'], ['290', 'PagBank'], ['380', 'PicPay'], ['403', 'Cora'], ['197', 'Stone'],
];
const ContasBancarias = {
  dig: s => String(s ?? '').replace(/\D/g, ''),
  semZero: s => String(s ?? '').replace(/\D/g, '').replace(/^0+/, ''),
  rotulo(c) { return c ? `${c.apelido || c.bancoNome || c.banco} · Ag ${c.agencia || '—'} · CC ${c.conta}${c.digito ? '-' + c.digito : ''}` : '—'; },
  /**
   * Encontra a conta cadastrada que corresponde ao OFX. Ordem de prioridade:
   * 1) identificador OFX informado manualmente (ACCTID exato);
   * 2) banco + conta (com ou sem dígito, aceitando agência/zeros à esquerda no ACCTID) + agência quando o OFX trouxer.
   */
  vincular(ofxConta, contas) {
    const a = this.semZero(ofxConta.acctId), b = this.semZero(ofxConta.bankId), ag = this.semZero(ofxConta.branchId);
    const ativas = contas.filter(c => c.ativa !== false);
    const manual = ativas.find(c => c.ofxAcctId && this.semZero(c.ofxAcctId) === a);
    if (manual) return { conta: manual, criterio: 'identificador OFX' };
    let melhor = null;
    for (const c of ativas) {
      if (b && this.semZero(c.banco) !== b) continue;
      const comDv = this.semZero((c.conta || '') + (c.digito || '')), semDv = this.semZero(c.conta);
      const contaOk = a === comDv || a === semDv || (comDv.length >= 5 && a.endsWith(comDv)) || (semDv.length >= 5 && a.endsWith(semDv) && a.length - semDv.length <= 6);
      if (!contaOk) continue;
      const agOk = !ag || !c.agencia || this.semZero(c.agencia) === ag || ag.startsWith(this.semZero(c.agencia));
      if (!agOk) continue;
      const pontos = (a === comDv ? 3 : a === semDv ? 2 : 1) + (ag && c.agencia ? 1 : 0);
      if (!melhor || pontos > melhor.pontos) melhor = { conta: c, pontos, criterio: 'banco + agência + conta' };
    }
    return melhor ? { conta: melhor.conta, criterio: melhor.criterio } : null;
  },
  /** Sugestão de cadastro a partir do OFX (usada quando a conta ainda não existe). */
  sugestao(ofxConta) {
    const banco = this.dig(ofxConta.bankId).slice(-3).padStart(3, '0'), acct = String(ofxConta.acctId || '');
    const m = acct.match(/^(.*?)[-\s]?(\w)$/);
    const bancoNome = (BANCOS.find(x => x[0] === banco) || [])[1] || '';
    return { banco, bancoNome, agencia: this.dig(ofxConta.branchId), conta: m && acct.includes('-') ? this.dig(m[1]) : this.dig(acct), digito: m && acct.includes('-') ? m[2] : '', ofxAcctId: acct, tipo: ofxConta.cartao ? 'Cartão de crédito' : 'Conta corrente', apelido: bancoNome };
  },
};

/* ============================ DFC ============================ */
/* Demonstração dos Fluxos de Caixa — método direto (CPC 03). */
const DFC_GRUPOS = {
  OPERACIONAL: 'Atividades operacionais',
  INVESTIMENTO: 'Atividades de investimento',
  FINANCIAMENTO: 'Atividades de financiamento',
  TRANSFERENCIA: 'Transferências entre contas próprias (não afetam o caixa consolidado)',
};
const DFC_CATEGORIAS = [
  { id: 'rec_cartoes', nome: 'Recebimento de cartões (adquirentes)', grupo: 'OPERACIONAL', sentido: 'E' },
  { id: 'rec_credsystem', nome: 'Recebimento Credsystem', grupo: 'OPERACIONAL', sentido: 'E' },
  { id: 'rec_depositos', nome: 'Depósitos das lojas (numerário)', grupo: 'OPERACIONAL', sentido: 'E' },
  { id: 'rec_pix', nome: 'PIX recebidos', grupo: 'OPERACIONAL', sentido: 'E' },
  { id: 'rec_outros', nome: 'Outras entradas operacionais', grupo: 'OPERACIONAL', sentido: 'E' },
  { id: 'pag_fornecedores', nome: 'Pagamento a fornecedores', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_repasse_credsystem', nome: 'Repasse de prestações à Credsystem', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_folha', nome: 'Folha de pagamento e benefícios', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_impostos', nome: 'Impostos, encargos e parcelamentos', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_ocupacao', nome: 'Aluguel, condomínio e ocupação', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_utilidades', nome: 'Energia, água e telecom', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_tarifas', nome: 'Tarifas e juros bancários', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_administrativas', nome: 'Despesas administrativas e serviços', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_marketing', nome: 'Marketing e publicidade', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'pag_outros', nome: 'Outras saídas operacionais', grupo: 'OPERACIONAL', sentido: 'S' },
  { id: 'inv_capex', nome: 'Obras, equipamentos e imobilizado', grupo: 'INVESTIMENTO', sentido: 'S' },
  { id: 'inv_aplicacao', nome: 'Aplicações financeiras', grupo: 'INVESTIMENTO', sentido: 'S' },
  { id: 'inv_resgate', nome: 'Resgates de aplicações', grupo: 'INVESTIMENTO', sentido: 'E' },
  { id: 'fin_captacao', nome: 'Empréstimos e financiamentos captados', grupo: 'FINANCIAMENTO', sentido: 'E' },
  { id: 'fin_amortizacao', nome: 'Amortização de empréstimos', grupo: 'FINANCIAMENTO', sentido: 'S' },
  { id: 'transf', nome: 'Transferência entre contas próprias', grupo: 'TRANSFERENCIA', sentido: '*' },
];
/** Regras padrão (termos procurados no histórico do extrato). Editáveis na tela → config/dfc. */
const DFC_REGRAS_PADRAO = [
  { id: 'r-transf', termos: ['MESMA TITULARIDADE', 'TRANSF ENTRE CONTAS', 'TRANSFERENCIA ENTRE CONTAS', 'ESPOSENDE CALCADOS'], sentido: '*', categoria: 'transf' },
  { id: 'r-cartoes', termos: ['GETNET', 'CIELO', 'REDECARD', 'REDE S.A', 'STONE', 'PAGSEGURO', 'SAFRAPAY', 'ADQUIRENTE', 'ANTECIPACAO'], sentido: 'E', categoria: 'rec_cartoes' },
  { id: 'r-credsystem', termos: ['CREDSYSTEM'], sentido: 'E', categoria: 'rec_credsystem' },
  { id: 'r-repasse', termos: ['CREDSYSTEM'], sentido: 'S', categoria: 'pag_repasse_credsystem' },
  { id: 'r-deposito', termos: ['DEPOSITO', 'DEP DINHEIRO', 'DEP. DINHEIRO', 'DEP ESPECIE', 'RECOLHIMENTO'], sentido: 'E', categoria: 'rec_depositos' },
  { id: 'r-resgate', termos: ['RESGATE', 'RESG '], sentido: 'E', categoria: 'inv_resgate' },
  { id: 'r-emprestimo', termos: ['EMPRESTIMO', 'CAPITAL DE GIRO', 'FINANCIAMENTO', 'CREDITO LIBERADO'], sentido: 'E', categoria: 'fin_captacao' },
  { id: 'r-pix-rec', termos: ['PIX RECEB', 'PIX - RECEB', 'RECEBIMENTO PIX', 'PIX CRED'], sentido: 'E', categoria: 'rec_pix' },
  { id: 'r-aplicacao', termos: ['APLICACAO', 'APLIC ', 'CDB', 'INVEST'], sentido: 'S', categoria: 'inv_aplicacao' },
  { id: 'r-amortiz', termos: ['PARC EMPREST', 'AMORTIZ', 'PRESTACAO EMPREST', 'CAPITAL DE GIRO'], sentido: 'S', categoria: 'fin_amortizacao' },
  { id: 'r-folha', termos: ['FOLHA', 'SALARIO', 'PAGTO SAL', 'PROVENTOS', 'VALE TRANSP', 'BENEFICIO'], sentido: 'S', categoria: 'pag_folha' },
  { id: 'r-impostos', termos: ['DARF', 'GPS', 'DAE', 'SEFAZ', 'ICMS', 'FGTS', 'GRF', 'SIMPLES NAC', 'TRIBUTO', 'PARCELAMENTO'], sentido: 'S', categoria: 'pag_impostos' },
  { id: 'r-ocupacao', termos: ['ALUGUEL', 'CONDOMINIO', 'SHOPPING', 'FUNDO DE PROMOCAO', 'IPTU'], sentido: 'S', categoria: 'pag_ocupacao' },
  { id: 'r-utilidades', termos: ['NEOENERGIA', 'ENERGISA', 'EQUATORIAL', 'COMPESA', 'CAGEPA', 'CAERN', 'CASAL', 'EMBASA', 'CLARO', 'VIVO', 'TIM ', 'OI '], sentido: 'S', categoria: 'pag_utilidades' },
  { id: 'r-admin', termos: ['CONTABIL', 'ASSESSORIA', 'HONORARIO', 'SISTEMA', 'SOFTWARE', 'LICENCA', 'CONSULTORIA', 'SEGURO'], sentido: 'S', categoria: 'pag_administrativas' },
  { id: 'r-marketing', termos: ['MARKETING', 'PUBLICIDADE', 'AGENCIA', 'FACEBK', 'META ADS', 'GOOGLE ADS'], sentido: 'S', categoria: 'pag_marketing' },
  { id: 'r-tarifas', termos: ['TARIFA', 'TAR ', 'CESTA', 'IOF', 'JUROS', 'ENCARGOS'], sentido: 'S', categoria: 'pag_tarifas' },
  { id: 'r-fornec', termos: ['PAG TIT', 'PAGTO TITULO', 'PAG BOLETO', 'PAGAMENTO DE BOLETO', 'LIQUIDACAO', 'ALPARGATAS', 'GRENDENE', 'BEIRA RIO', 'VULCABRAS', 'DEMOCRATA'], sentido: 'S', categoria: 'pag_fornecedores' },
];
const DFC = {
  cat: id => DFC_CATEGORIAS.find(c => c.id === id),
  norm: s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(),
  regras() { return (typeof Repo !== 'undefined' && Repo.get('config', 'dfc')?.regras) || DFC_REGRAS_PADRAO; },
  /** Categoria de uma transação: manual (cat) > primeira regra que casar > padrão pelo sinal. */
  classificar(t, regras = this.regras()) {
    if (t.cat) return { categoria: t.cat, origem: 'manual' };
    const h = this.norm(t.hist), sentido = t.valor >= 0 ? 'E' : 'S';
    for (const r of regras) {
      if (r.sentido !== '*' && r.sentido !== sentido) continue;
      if ((r.termos || []).some(x => x && h.includes(this.norm(x)))) return { categoria: r.categoria, origem: 'regra', regra: r.id };
    }
    return { categoria: sentido === 'E' ? 'rec_outros' : 'pag_outros', origem: 'padrão' };
  },
  /**
   * Consolida transações (já com contaId) em KPIs da DFC.
   * Transferências entre contas próprias ficam fora de entradas/saídas.
   */
  consolidar(transacoes, regras = this.regras()) {
    const r = { entradas: 0, saidas: 0, liquido: 0, transferencias: 0, semRegra: 0, n: 0, porGrupo: {}, porCategoria: {}, porConta: {}, porDia: {} };
    Object.keys(DFC_GRUPOS).forEach(g => { r.porGrupo[g] = { entradas: 0, saidas: 0, liquido: 0 }; });
    for (const t of transacoes) {
      const c = this.classificar(t, regras), cat = this.cat(c.categoria) || this.cat(t.valor >= 0 ? 'rec_outros' : 'pag_outros');
      if (c.origem === 'padrão') r.semRegra++;
      const pc = r.porCategoria[cat.id] ||= { valor: 0, n: 0 }; pc.valor += t.valor; pc.n++;
      const g = r.porGrupo[cat.grupo]; if (t.valor >= 0) g.entradas += t.valor; else g.saidas += -t.valor; g.liquido += t.valor;
      r.n++;
      if (cat.grupo === 'TRANSFERENCIA') { r.transferencias += Math.abs(t.valor); continue; }
      if (t.valor >= 0) r.entradas += t.valor; else r.saidas += -t.valor;
      r.liquido += t.valor;
      const pk = r.porConta[t.contaId] ||= { entradas: 0, saidas: 0 }; if (t.valor >= 0) pk.entradas += t.valor; else pk.saidas += -t.valor;
      const d = r.porDia[t.data] ||= { entradas: 0, saidas: 0 }; if (t.valor >= 0) d.entradas += t.valor; else d.saidas += -t.valor;
    }
    const r2 = n => Math.round(n * 100) / 100;
    ['entradas', 'saidas', 'liquido', 'transferencias'].forEach(k => r[k] = r2(r[k]));
    Object.values(r.porGrupo).forEach(g => { g.entradas = r2(g.entradas); g.saidas = r2(g.saidas); g.liquido = r2(g.liquido); });
    Object.values(r.porCategoria).forEach(c => { c.valor = r2(c.valor); });
    return r;
  },
};

/* ============================ IEO ============================ */
/* Índice de Eficiência Operacional: cada loja começa o mês com 100 pontos. */
const IEO_PADRAO = {
  pontosIniciais: 100,
  faixas: { verde: 85, vermelha: 60 },   // ≥ 85 verde · 60 a 84,99 amarela · < 60 vermelha
  prazoJustificativaDias: 3,              // falta sem justificativa após N dias → "Atraso na justificativa"
  reincidenciaMinima: 3,                  // a partir da 3ª falta do mesmo caixa no mês, vale a dedução de reincidência
  tipos: [
    { id: 'falta_isolada', nome: 'Falta de caixa (numerário) isolada', pontos: -10, origem: 'faltas', ativo: true },
    { id: 'quebra_reincidente', nome: 'Quebra de caixa reincidente (3x ou mais)', pontos: -20, origem: 'faltas_reincidencia', ativo: true },
    { id: 'div_recebimentos', nome: 'Divergência de recebimentos (Cartão/Credsystem)', pontos: -5, origem: 'credsystem', ativo: true },
    { id: 'erro_pix', nome: 'Erro de lançamento ou baixa de PIX', pontos: -5, origem: 'manual', ativo: true },
    { id: 'atraso_justificativa', nome: 'Atraso na justificativa processual', pontos: -2, origem: 'faltas_atraso', ativo: true },
  ],
};
const IEO_ORIGENS = {
  manual: 'Lançamento manual',
  faltas: 'Automática · faltas de caixa (1ª e 2ª do caixa no mês)',
  faltas_reincidencia: 'Automática · faltas a partir da reincidência',
  credsystem: 'Automática · divergências da conciliação Credsystem',
  faltas_atraso: 'Automática · falta sem justificativa após o prazo',
};
const IEO = {
  matriz() { const s = typeof Repo !== 'undefined' && Repo.get('config', 'ieo'); return s && s.tipos ? { ...IEO_PADRAO, ...s, faixas: { ...IEO_PADRAO.faixas, ...(s.faixas || {}) } } : IEO_PADRAO; },
  zona(p, m = this.matriz()) { return p >= m.faixas.verde ? 'verde' : p < m.faixas.vermelha ? 'vermelha' : 'amarela'; },
  ZONAS: { verde: { rotulo: 'Zona Verde', desc: 'Excelência / Conformidade', cls: 'ok' }, amarela: { rotulo: 'Zona Amarela', desc: 'Atenção / Monitoramento', cls: 'warn' }, vermelha: { rotulo: 'Zona Vermelha', desc: 'Estado crítico', cls: 'bad' } },

  /**
   * Motor de pontuação (função pura).
   * @param mes        'AAAA-MM'
   * @param lojas      [{id, codigo, nome, ativa}]
   * @param faltas     itens de faltas [{lojaId, data, tipo, valor, status, justificativa, caixa}]
   * @param credsystem linhas conciliadas [{lojaId, data, st, dif}]
   * @param ocorrencias lançamentos manuais [{lojaId, data, tipoId, descricao}]
   * @returns ranking [{lojaId, pontos, zona, posicao, deducoes[], resumo{tipoId:{n,pontos}}}]
   */
  calcular({ mes, lojas, faltas = [], credsystem = [], ocorrencias = [], matriz = this.matriz(), hoje = new Date().toISOString().slice(0, 10) }) {
    const tipos = Object.fromEntries(matriz.tipos.filter(t => t.ativo !== false).map(t => [t.id, t]));
    const porOrigem = o => matriz.tipos.find(t => t.ativo !== false && t.origem === o);
    const res = {};
    lojas.forEach(l => { res[l.id] = { lojaId: l.id, codigo: l.codigo, nome: l.nome, deducoes: [] }; });
    const add = (lojaId, tipo, data, detalhe, ref) => { if (tipo && res[lojaId]) res[lojaId].deducoes.push({ tipoId: tipo.id, nome: tipo.nome, pontos: Number(tipo.pontos) || 0, data, detalhe, ref, origem: tipo.origem }); };

    // 1) Faltas de caixa: 1ª e 2ª do caixa no mês = isolada; a partir da N-ésima = reincidente. Sobras e abonadas não pontuam.
    const tIsolada = porOrigem('faltas'), tReinc = porOrigem('faltas_reincidencia'), tAtraso = porOrigem('faltas_atraso');
    const doMes = faltas.filter(f => f.data && f.data.startsWith(mes) && f.tipo !== 'Sobra' && f.status !== 'Abonada').sort((a, b) => a.data.localeCompare(b.data));
    const contagem = {};
    for (const f of doMes) {
      const k = f.lojaId + '|' + (f.caixa?.id || String(f.caixa?.nome || '').toUpperCase());
      const n = (contagem[k] = (contagem[k] || 0) + 1);
      const reinc = n >= (matriz.reincidenciaMinima || 3);
      add(f.lojaId, reinc && tReinc ? tReinc : tIsolada, f.data, `${reinc ? `${n}ª quebra do caixa` : 'Falta'} ${f.caixa?.nome || ''} · R$ ${Number(f.valor).toFixed(2).replace('.', ',')}`, f.id);
      // 2) Atraso na justificativa
      if (tAtraso && !String(f.justificativa || '').trim()) {
        const dias = Math.floor((Date.parse(hoje) - Date.parse(f.data)) / 864e5);
        if (dias > (matriz.prazoJustificativaDias ?? 3)) add(f.lojaId, tAtraso, f.data, `Falta de ${f.caixa?.nome || 'caixa'} sem justificativa há ${dias} dias`, f.id);
      }
    }
    // 3) Divergências de recebimento (Credsystem)
    const tDiv = porOrigem('credsystem');
    credsystem.filter(l => l.data && l.data.startsWith(mes) && l.st === 'div').forEach(l => add(l.lojaId, tDiv, l.data, `Divergência Credsystem de R$ ${l.dif.toFixed(2).replace('.', ',')}`, l.data));
    // 4) Ocorrências manuais (qualquer tipo da matriz)
    ocorrencias.filter(o => o.data && o.data.startsWith(mes)).forEach(o => add(o.lojaId, tipos[o.tipoId], o.data, o.descricao || '', o.id));

    const lista = Object.values(res).map(r => {
      const total = r.deducoes.reduce((a, d) => a + d.pontos, 0);
      const pontos = Math.max(0, Math.round((matriz.pontosIniciais + total) * 100) / 100);
      const resumo = {}; r.deducoes.forEach(d => { const x = resumo[d.tipoId] ||= { nome: d.nome, n: 0, pontos: 0, unit: d.pontos }; x.n++; x.pontos += d.pontos; });
      return { ...r, deducoes: r.deducoes.sort((a, b) => a.data.localeCompare(b.data)), pontos, zona: this.zona(pontos, matriz), resumo };
    }).sort((a, b) => b.pontos - a.pontos || a.deducoes.length - b.deducoes.length || a.codigo.localeCompare(b.codigo));
    lista.forEach((r, i) => { r.posicao = i + 1; });
    return lista;
  },
};

/* ============================ LAUDO (IA) ============================ */
/**
 * Prompt interno do Motor de Laudos. A IA recebe SOMENTE os dados do ciclo
 * (JSON abaixo) e redige o Laudo de Performance em texto corrido.
 */
const LAUDO_PROMPT = `Você é o auditor de retaguarda financeira da Esposende, rede de lojas de calçados do Nordeste.
Redija o LAUDO DE PERFORMANCE mensal de uma loja a partir do Índice de Eficiência Operacional (IEO).

Regras do IEO: toda loja inicia o mês com a pontuação inicial informada; cada ocorrência da matriz deduz pontos.
Zonas: Verde (Excelência/Conformidade) a partir do limite verde; Amarela (Atenção/Monitoramento) abaixo dele; Vermelha (Estado crítico) abaixo do limite vermelho.

Como escrever:
- Português do Brasil, texto corrido em 2 ou 3 parágrafos, de 110 a 200 palavras. Sem títulos, listas, tabelas, markdown ou emojis.
- 1º parágrafo: pontuação inicial, cada tipo de dedução com quantidade e pontos (ex.: "2 deduções por falhas no PIX (-10)"), pontuação final e zona.
- 2º parágrafo: posição no ranking entre o total de lojas, movimento em relação ao mês anterior quando houver, e comparação com a média da rede.
- 3º parágrafo (se houver dedução): uma recomendação objetiva focada na causa que mais tirou pontos. Se não houver deduções, reconheça a conformidade.
- Use somente os números fornecidos; não invente datas, valores, nomes ou causas. Números no padrão brasileiro (vírgula decimal).
- Tom profissional e direto, adequado para a supervisão regional e para o gerente da loja.
Responda apenas com o texto do laudo.`;

const Laudo = {
  /** Estrutura os dados do ciclo para a IA (e para o laudo automático). */
  dados(r, { ranking, anterior, mes, loja, matriz = IEO.matriz() }) {
    const ant = anterior ? anterior.find(x => x.lojaId === r.lojaId) : null;
    const media = ranking.reduce((a, x) => a + x.pontos, 0) / (ranking.length || 1);
    const [y, m] = mes.split('-');
    return {
      loja: { codigo: r.codigo, nome: r.nome, tipo: loja?.tipo || '', supervisor: loja?.supervisor || '' },
      periodo: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][+m - 1] + ' de ' + y,
      pontosIniciais: matriz.pontosIniciais, pontosFinais: r.pontos,
      zona: IEO.ZONAS[r.zona].rotulo + ' — ' + IEO.ZONAS[r.zona].desc,
      limites: { verde: matriz.faixas.verde, vermelha: matriz.faixas.vermelha },
      posicao: r.posicao, totalLojas: ranking.length,
      posicaoAnterior: ant ? ant.posicao : null, pontosAnteriores: ant ? ant.pontos : null,
      mediaRede: Math.round(media * 10) / 10,
      deducoes: Object.entries(r.resumo).sort((a, b) => a[1].pontos - b[1].pontos).map(([id, x]) => ({ tipoId: id, tipo: x.nome, quantidade: x.n, pontosPorOcorrencia: x.unit, totalPontos: x.pontos })),
      exemplos: r.deducoes.slice(0, 8).map(d => `${d.data.split('-').reverse().join('/')}: ${d.nome} (${d.pontos}) — ${d.detalhe}`),
    };
  },
  prompt(d) { return LAUDO_PROMPT + '\n\nDADOS DO CICLO (JSON):\n' + JSON.stringify(d, null, 2); },
  /** Laudo automático (sem IA) — mesmo formato; usado como alternativa e pré-visualização. */
  local(d) {
    const n = v => String(v).replace('.', ',');
    const plural = (q, s, p) => q === 1 ? s : p;
    const partes = d.deducoes.map(x => `${x.quantidade} ${plural(x.quantidade, 'dedução', 'deduções')} por ${x.tipo.charAt(0).toLowerCase() + x.tipo.slice(1)} (${n(x.totalPontos)})`);
    const lista = partes.length > 1 ? partes.slice(0, -1).join(', ') + ' e ' + partes.at(-1) : partes[0];
    let p1 = partes.length
      ? `A loja ${d.loja.codigo} · ${d.loja.nome} iniciou ${d.periodo} com ${d.pontosIniciais} pontos, mas sofreu ${lista}, terminando com ${n(d.pontosFinais)} pontos (${d.zona}).`
      : `A loja ${d.loja.codigo} · ${d.loja.nome} iniciou ${d.periodo} com ${d.pontosIniciais} pontos e não registrou nenhuma dedução, mantendo ${n(d.pontosFinais)} pontos (${d.zona}).`;
    const pos = d.posicao === d.totalLojas ? 'a última posição' : d.posicao === d.totalLojas - 1 ? 'a penúltima posição' : `a ${d.posicao}ª posição`;
    let mov = '';
    const dp = Math.abs((d.posicaoAnterior || 0) - d.posicao), pos2 = `${dp} ${plural(dp, 'posição', 'posições')}`;
    if (d.posicaoAnterior) mov = d.posicaoAnterior > d.posicao ? ` Subiu ${pos2} em relação ao mês anterior, quando era a ${d.posicaoAnterior}ª.` : d.posicaoAnterior < d.posicao ? ` Caiu ${pos2} em relação ao mês anterior, quando era a ${d.posicaoAnterior}ª.` : ' Manteve a mesma posição do mês anterior.';
    const p2 = `No ranking da rede, ocupa ${pos} entre ${d.totalLojas} lojas; a média da rede foi de ${n(d.mediaRede)} pontos.${mov}`;
    const pior = d.deducoes[0];
    const rec = {
      falta_isolada: 'reforçar a conferência de troco e o fechamento cego do caixa, com acompanhamento do gerente no encerramento de cada turno',
      quebra_reincidente: 'tratar individualmente o caixa reincidente (reciclagem, conversa formal e, se persistir, remanejamento de função)',
      div_recebimentos: 'conferir diariamente o relatório do Websystem contra o fechamento da loja antes do envio à retaguarda',
      erro_pix: 'padronizar a baixa de PIX pelo comprovante no sistema e conferir o extrato do dia antes do fechamento',
      atraso_justificativa: 'cumprir o prazo de justificativa das faltas, registrando o ocorrido no mesmo dia',
    };
    const p3 = pior ? `A principal causa de perda foi ${pior.tipo.charAt(0).toLowerCase() + pior.tipo.slice(1)} (${n(pior.totalPontos)} pontos). Recomenda-se ${rec[pior.tipoId] || 'que a supervisão acompanhe a rotina da loja com revisão semanal até o próximo ciclo'}.` : 'A loja segue em conformidade e serve de referência operacional para as demais.';
    return [p1, p2, p3].join('\n\n');
  },
  async gerarIA(d) {
    const sample = typeof Cloud !== 'undefined' && Cloud.caps.sample;
    if (!sample) throw new Error('A leitura por IA está desligada: o Master liga em Configurações de Integração.');
    const r = await sample(this.prompt(d), { modelTier: 'default' });
    return (r.text || '').trim();
  },
};

if (typeof module !== 'undefined') module.exports = { OFX, ContasBancarias, DFC, DFC_REGRAS_PADRAO, DFC_CATEGORIAS, IEO, IEO_PADRAO, Laudo, LAUDO_PROMPT };
