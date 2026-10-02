/* =====================================================================
   MÓDULO 4 — AUDITORIA DE ADQUIRENTES (taxas + conciliação tripla de cartões)
   Regra de negócio: a operação antecipa 100% dos recebíveis (flag por regra).

   Camadas:
     5 Repositório → adq_taxas/<adquirente>__<bandeira>  regras por ADQUIRENTE + OPERADORA/BANDEIRA (GESTOR)
                     ex.: GETNET - VISA · GETNET - MASTER · CREDSYSTEM - ESPOSENDE CARD
                     adq_auditorias/<AAAA-MM> (KPIs) · adq_excecoes/<AAAA-MM>_<n> (exceções, 1.000 por doc)
     6 Serviços    → LeitorArquivosAdq (XLSX/CSV; reconhece os layouts oficiais e cai no mapeamento genérico)
                     MotorConciliacao   (ERP × adquirente × banco; o que não tem arquivo da adquirente vai no modo direto)
     7 UI          → Retaguarda.renderAdq … (aba "Auditoria de Adquirentes")

   ERP (VENDASGETNET_ERP.XLSX / VENDASCREDSYSTEM_ERP.XLSX — "Controle dos cartões"): uma linha por PARCELA.
     EMPRESA "05-005 - CAMARAGIBE" · LANÇAMENTO · VENCIMENTO · DOCUMENTO "CE244205-1/6" | "LOTE2016920012" · COMPLEMENTO "PAR 1/06"
     VALOR · TAXA (MDR no ERP) · VALOR LÍQUIDO · AUTORIZAÇÃO · OPERADORA "GETNET - VISA" | "CREDSYSTEM" · STATUS
     • DOCUMENTO com "LOTE" = Recebimento de Prestação; os demais = Venda.
     • OPERADORA → adquirente + bandeira ("CREDSYSTEM" → CREDSYSTEM / ESPOSENDE CARD).

   Liquidação da adquirente (layouts oficiais, reconhecidos pelo cabeçalho):
     GETNET  "Vendas_Detalhado_…xlsx" (aba CARTÕES): uma linha por VENDA — BANDEIRA, FORMA DE PAGAMENTO, DATA/HORA DA VENDA,
             PARCELAS, DATA PREVISTA DO 1º PAGAMENTO, NÚMERO DE AUTORIZAÇÃO (AUT), CV (NSU), VALOR BRUTO, VALOR TAXA, VALOR LÍQUIDO.
             Casa com o ERP por AUTORIZAÇÃO + data (soma as parcelas do ERP). O líquido do arquivo é pós-MDR; a antecipação
             é descontada no repasse (calculada pelo contrato, dias até o vencimento de cada parcela).
     CREDSYSTEM "Antecipados - 610.csv": uma linha por LOJA × VENCIMENTO antecipado — FANTASIA, PERIODO_VE (vendas),
             VALOR_LIQ (pós-MDR), VENCIMENTO, PAGAMENTO, TAXA (% a.m.), N_DIAS, VALOR_ANT (pago), RECEITA_AN (custo).
             Casa com o ERP por loja + período de venda + mês do vencimento (a Credsystem não informa NSU).

   Motor (por adquirente e data de venda):
     • coberto por arquivo da adquirente → TRIPLO
         Taxa:    esperado = bruto − MDR(contrato) − antecipação(contrato); pago abaixo do esperado − R$ 0,02 → "Divergência de taxa"
         Repasse: soma o líquido de vendas + prestações (LOTE) da mesma adquirente e data de pagamento e procura no OFX
                  (Módulo 3) até D+1 útil; ausente ou menor → "Furo de repasse"
     • sem arquivo da adquirente → DIRETO: líquido estimado pelo contrato × crédito no OFX (abaixo = divergência, ausente = furo)
   ===================================================================== */
const ADQ_CFG = { tolParcela: 0.02, tolRepasseAbs: 0.05, tolRepassePct: 0.0001, tolEstAbs: 1.00, tolEstPct: 0.0005, maxExcecoes: 10000, porDoc: 1000, lote: 4000, tolArred: 0.005 };
const ADQ_MODALIDADES = { debito: 'Débito', credito: 'Crédito', voucher: 'Voucher / benefício', pix: 'PIX' };
const ADQ_CREDSYSTEM = 'CREDSYSTEM', ADQ_ESPOSENDE_CARD = 'ESPOSENDE CARD'; // adquirente nativa + bandeira própria
const ADQ_ALIASES_PADRAO = {
  GETNET: ['GETNET', 'SANTANDER GETNET'], CIELO: ['CIELO'], REDE: ['REDE', 'REDECARD', 'ITAU REDE'], STONE: ['STONE'],
  PAGSEGURO: ['PAGSEGURO', 'PAGBANK', 'PAGSEG'], SAFRAPAY: ['SAFRAPAY', 'SAFRA PAY'], SIPAG: ['SIPAG'], VERO: ['VERO', 'BANRISUL'],
  CREDSYSTEM: ['CREDSYSTEM', 'CRED SYSTEM', 'ESPOSENDE CARD', 'ESP CARD', 'ESPCARD'],
};
/** Bandeiras reconhecidas na coluna OPERADORA (apelido → nome da regra). */
const ADQ_BANDEIRAS = [['MASTERCARD', 'MASTER'], ['MASTER', 'MASTER'], ['VISA', 'VISA'], ['ELO', 'ELO'], ['AMERICAN EXPRESS', 'AMEX'], ['AMEX', 'AMEX'], ['HIPERCARD', 'HIPERCARD'], ['HIPER', 'HIPERCARD'],
  ['CABAL', 'CABAL'], ['DINERS', 'DINERS'], ['SOROCRED', 'SOROCRED'], ['GOODCARD', 'GOODCARD'], ['BANESCARD', 'BANESCARD'], ['JCB', 'JCB'], ['DISCOVER', 'DISCOVER'], ['ESPOSENDE CARD', 'ESPOSENDE CARD']];
const ADQ_FAIXAS_PADRAO = [
  { modalidade: 'debito', de: 1, ate: 1, taxa: null }, { modalidade: 'credito', de: 1, ate: 1, taxa: null },
  { modalidade: 'credito', de: 2, ate: 6, taxa: null }, { modalidade: 'credito', de: 7, ate: 12, taxa: null },
];

/* ============================ Util: dias úteis (feriados nacionais bancários) ============================ */
const DiasUteis = {
  _fer: {},
  pascoa(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1; return Date.UTC(y, mes - 1, dia); },
  feriados(y) {
    if (this._fer[y]) return this._fer[y];
    const iso = t => new Date(t).toISOString().slice(0, 10), p = this.pascoa(y), D = 864e5;
    const s = new Set(['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map(x => `${y}-${x}`));
    [-48, -47, -2, 60].forEach(n => s.add(iso(p + n * D))); // carnaval (seg/ter), sexta-feira santa, Corpus Christi
    return this._fer[y] = s;
  },
  util(iso) { const d = new Date(iso + 'T12:00:00Z').getUTCDay(); return d !== 0 && d !== 6 && !this.feriados(+iso.slice(0, 4)).has(iso); },
  proximo(iso) { let x = iso; while (!this.util(x)) x = MotorConciliacao.somaDias(x, 1); return x; },
  somar(iso, n) { let x = iso; for (let i = 0; i < n; i++) { x = MotorConciliacao.somaDias(x, 1); while (!this.util(x)) x = MotorConciliacao.somaDias(x, 1); } return this.proximo(x); },
};

/* ============================ 5. REPOSITÓRIO ============================ */
const AdqTaxas = {
  COL: 'adq_taxas',
  chave: s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(),
  slug(s) { return this.chave(s).toLowerCase().replace(/\s+/g, '-') || 'x'; },
  adqId(nome) { return 'adq-' + this.slug(nome); },
  idRegra(adquirente, bandeira) { return `${this.adqId(adquirente)}__${bandeira && bandeira !== '*' ? this.slug(bandeira) : 'todas'}`; },
  /** Normaliza (inclui documentos da v9: taxa global por adquirente = regra "todas as bandeiras"). */
  norm(d) {
    if (!d) return null;
    let adquirente = this.chave(d.adquirente || d.nome || ''), bandeira = d.bandeira || '*';
    if (adquirente === ADQ_ESPOSENDE_CARD) { adquirente = ADQ_CREDSYSTEM; bandeira = ADQ_ESPOSENDE_CARD; } // regra da v10
    if (adquirente === ADQ_CREDSYSTEM && bandeira === '*') bandeira = ADQ_ESPOSENDE_CARD;
    return { ...d, adquirente, bandeira, adq: this.adqId(adquirente), antecipado: d.antecipado !== false, prazoRepasse: Number(d.prazoRepasse) || 1, mdr: d.mdr || [] };
  },
  regras() { return Repo.todos(this.COL).filter(t => t.ativo !== false).map(t => this.norm(t)).sort((a, b) => a.adquirente.localeCompare(b.adquirente) || (a.bandeira === '*' ? -1 : b.bandeira === '*' ? 1 : a.bandeira.localeCompare(b.bandeira))); },
  adquirentes() { const s = new Set(['GETNET', ADQ_CREDSYSTEM, ...this.regras().map(r => r.adquirente)]); return [...s].sort((a, b) => a === ADQ_CREDSYSTEM ? 1 : b === ADQ_CREDSYSTEM ? -1 : a.localeCompare(b)); },
  /** "GETNET - VISA" · "CREDSYSTEM - ESPOSENDE CARD" · "GETNET - todas as bandeiras". */
  rotulo(adquirente, bandeira) { return `${adquirente} - ${!bandeira || bandeira === '*' ? 'todas as bandeiras' : bandeira}`; },
  _idx: null,
  indice() {
    if (this._idx) return this._idx;
    const m = new Map(); this.regras().forEach(r => m.set(r.adq + '|' + r.bandeira, r));
    return this._idx = m;
  },
  regra(adq, bandeira) { const i = this.indice(); return i.get(adq + '|' + (bandeira || '*')) || i.get(adq + '|*') || null; },
  aliasesAdq(adq) {
    const regs = this.regras().filter(r => r.adq === adq), nome = regs[0]?.adquirente || this.nome(adq);
    return [...new Set([nome, ...regs.flatMap(r => r.aliases || []), ...(ADQ_ALIASES_PADRAO[nome] || [])].map(this.chave).filter(Boolean))];
  },
  nome(adq) { return this.regras().find(r => r.adq === adq)?.adquirente || String(adq).replace(/^adq-/, '').replace(/-/g, ' ').toUpperCase(); },
  _memo: new Map(),
  /** "GETNET - VISA", "GETNET-ES SPORTS (MASTER)", "ESPOSENDE CARD" → { adq, adquirente, bandeira }. Memoizado. */
  operadora(txt) {
    const s = String(txt ?? ''); if (this._memo.has(s)) return this._memo.get(s);
    const k = ' ' + this.chave(s) + ' ';
    let adquirente = null;
    const conhecidos = [...new Set([...this.regras().map(r => r.adquirente), ...Object.keys(ADQ_ALIASES_PADRAO)])];
    for (const a of conhecidos) { const al = [a, ...(ADQ_ALIASES_PADRAO[a] || []), ...this.regras().filter(r => r.adquirente === a).flatMap(r => r.aliases || [])].map(this.chave); if (al.some(x => x && k.includes(' ' + x + ' '))) { adquirente = a; break; } }
    if (!adquirente) adquirente = this.chave(s.split(/[-(]/)[0]) || 'DESCONHECIDA';
    const b = adquirente === ADQ_CREDSYSTEM ? [0, ADQ_ESPOSENDE_CARD] : ADQ_BANDEIRAS.find(([a]) => k.includes(' ' + a + ' '));
    const r = { adq: this.adqId(adquirente), adquirente, bandeira: b ? b[1] : '*' };
    this._memo.set(s, r); return r;
  },
  limparCache() { this._memo.clear(); this._idx = null; },
  mdr(r, modalidade, parcelas) {
    const f = (r?.mdr || []).find(x => x.modalidade === modalidade && parcelas >= Number(x.de || 1) && parcelas <= Number(x.ate || x.de || 1) && x.taxa != null && x.taxa !== '');
    return f ? Number(f.taxa) : null;
  },
  antecipacaoMes(r) {
    const a = r?.antecipacao; if (!a || a.taxa == null || a.taxa === '') return null;
    const i = Number(a.taxa) / 100;
    return a.unidade === 'aa' ? (a.metodo === 'composto' ? Math.pow(1 + i, 1 / 12) - 1 : i / 12) : i;
  },
  async salvar(id, d) {
    const adquirente = this.chave(d.adquirente), bandeira = d.bandeira && d.bandeira !== '*' ? this.chave(d.bandeira) : adquirente === ADQ_CREDSYSTEM ? ADQ_ESPOSENDE_CARD : '*';
    const rid = id || this.idRegra(adquirente, bandeira);
    const { id: _, ...antes } = Repo.get(this.COL, rid) || {};
    await Repo.salvar(this.COL, rid, { ...antes, ...d, adquirente, bandeira, ativo: true, nome: undefined }, { modulo: 'retaguarda', rotulo: `Taxas · ${this.rotulo(adquirente, bandeira)}` });
    this.limparCache(); return rid;
  },
  async remover(id) { const { id: _, ...x } = Repo.get(this.COL, id); await Repo.salvar(this.COL, id, { ...x, ativo: false }, { modulo: 'retaguarda', rotulo: `Taxas · ${x.adquirente || x.nome}`, detalhe: 'Regra removida' }); this.limparCache(); },
  /** Sugere regras (MDR por bandeira × modalidade × parcelas) a partir da TAXA lançada no ERP. */
  sugerir(vendas) {
    const obs = new Map();
    for (const v of vendas) {
      if (v.tipo === 'prestacao' || !(v.taxaErp > 0) || !(v.valor > 0)) continue;
      const k = `${v.adquirente}|${v.bandeira}|${v.modalidade}|${v.total}`, pct = Math.round(v.taxaErp / v.valor * 10000) / 100;
      const c = obs.get(k) || new Map(); c.set(pct, (c.get(pct) || 0) + 1); obs.set(k, c);
    }
    const regras = new Map();
    obs.forEach((c, k) => {
      const [adquirente, bandeira, modalidade, total] = k.split('|'), moda = [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const r = regras.get(adquirente + '|' + bandeira) || { adquirente, bandeira, mdr: [] };
      r.mdr.push({ modalidade, de: +total, ate: +total, taxa: moda, n: [...c.values()].reduce((a, b) => a + b, 0) }); regras.set(adquirente + '|' + bandeira, r);
    });
    // junta parcelas vizinhas com a mesma taxa (2x…6x a 1,63% → 2–6x) e cobre as lacunas até 12x
    const compactar = fs => {
      const out = [];
      for (const f of fs.sort((a, b) => a.de - b.de)) { const u = out.at(-1); if (u && u.taxa === f.taxa) { u.ate = f.ate; u.n += f.n; } else out.push({ ...f }); }
      if (fs[0]?.modalidade === 'credito') out.forEach((f, i) => { f.ate = i < out.length - 1 ? out[i + 1].de - 1 : Math.max(f.ate, 12); });
      return out;
    };
    return [...regras.values()].map(r => ({ ...r, mdr: ['debito', 'credito', 'voucher', 'pix'].flatMap(mo => compactar(r.mdr.filter(f => f.modalidade === mo))) }));
  },
};

/* ============================ 6. SERVIÇOS ============================ */
const LeitorArquivosAdq = {
  norm: s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
  CAMPOS: {
    adq: {
      adquirente: ['ADQUIRENTE', 'CREDENCIADORA', 'OPERADORA', 'ADQUIRENCIA'],
      bandeira: ['BANDEIRA', 'BANDEIRACARTAO'],
      loja: ['LOJA', 'FILIAL', 'ESTABELECIMENTO', 'CODIGOESTABELECIMENTO', 'EC', 'NUMEROESTABELECIMENTO', 'NOMEFANTASIA', 'PDV', 'EMPRESA'],
      dataVenda: ['DATAVENDA', 'DTVENDA', 'DATADAVENDA', 'DATATRANSACAO', 'DATAAUTORIZACAO'],
      nsu: ['NSU', 'NSUCV', 'CV', 'NUMEROCV', 'NSUHOST', 'DOC'],
      aut: ['AUTORIZACAO', 'CODAUTORIZACAO', 'CODIGOAUTORIZACAO', 'AUT', 'NUMEROAUTORIZACAO'],
      modalidade: ['MODALIDADE', 'PRODUTO', 'TIPOTRANSACAO', 'FORMAPAGAMENTO', 'TIPO', 'MODALIDADEPRODUTO'],
      parcela: ['PARCELA', 'NPARCELA', 'NUMEROPARCELA', 'NUMPARCELA'],
      totalParcelas: ['TOTALPARCELAS', 'QTDPARCELAS', 'QUANTIDADEPARCELAS', 'PLANO', 'PARCELAS', 'NUMEROPARCELAS'],
      venc: ['DATAVENCIMENTOORIGINAL', 'VENCIMENTOORIGINAL', 'DATAPREVISTA', 'DATAPREVISTAPAGAMENTO', 'DATAORIGINALPAGAMENTO', 'DATAVENCIMENTO', 'VENCIMENTO'],
      pagto: ['DATAPAGAMENTO', 'DTPAGAMENTO', 'DATAREPASSE', 'DATALIQUIDACAO', 'DATACREDITO', 'DATADOPAGAMENTO', 'PAGAMENTO'],
      bruto: ['VALORBRUTOPARCELA', 'VALORBRUTO', 'BRUTO', 'VALORPARCELA', 'VALORBRUTODAPARCELA', 'VALORVENDA'],
      mdrV: ['TAXAMDRVALOR', 'VALORMDR', 'MDR', 'VALORTAXAMDR', 'TAXAADMINISTRACAO', 'VALORTAXAADMINISTRACAO', 'TARIFA'],
      antV: ['TAXAANTECIPACAOVALOR', 'VALORANTECIPACAO', 'CUSTOANTECIPACAO', 'DESCONTOANTECIPACAO', 'VALORTAXAANTECIPACAO', 'TAXAANTECIPACAO'],
      liquido: ['VALORLIQUIDO', 'LIQUIDO', 'VALORLIQUIDOPAGO', 'VALORPAGO', 'VALORCREDITADO', 'VALORLIQUIDOPARCELA'],
    },
    erp: {
      data: ['LANCAMENTO', 'DATALANCAMENTO', 'DATA', 'DATAVENDA', 'DTVENDA', 'DATADAVENDA', 'EMISSAO', 'DATAEMISSAO'],
      venc: ['VENCIMENTO', 'DATAVENCIMENTO', 'VENCIMENTOORIGINAL', 'DATAPREVISTA', 'PREVISAO'],
      loja: ['EMPRESA', 'LOJA', 'FILIAL', 'CODIGOLOJA', 'ESTABELECIMENTO'],
      documento: ['DOCUMENTO', 'DOC', 'NUMERODOCUMENTO', 'CUPOM', 'TITULO'],
      complemento: ['COMPLEMENTO', 'PARCELAMENTO', 'DESCRICAO', 'HISTORICO'],
      operadora: ['OPERADORA', 'ADQUIRENTE', 'CREDENCIADORA', 'REDE'],
      bandeira: ['BANDEIRA'],
      modalidade: ['MODALIDADE', 'FORMAPAGAMENTO', 'TIPO', 'PRODUTO', 'MEIOPAGAMENTO'],
      totalParcelas: ['PARCELAS', 'TOTALPARCELAS', 'QTDPARCELAS', 'PLANO', 'NUMEROPARCELAS'],
      nsu: ['NSU', 'NSUCV', 'CV', 'NSUHOST'],
      aut: ['AUTORIZACAO', 'CODAUTORIZACAO', 'CODIGOAUTORIZACAO', 'AUT'],
      valor: ['VALOR', 'VALORBRUTO', 'VALORVENDA', 'VALORTOTAL', 'TOTAL'],
      taxa: ['TAXA', 'VALORTAXA', 'TAXAADM', 'TAXAADMINISTRACAO'],
      liquido: ['VALORLIQUIDO', 'LIQUIDO'],
      status: ['STATUS', 'SITUACAO'],
    },
  },
  OBRIGATORIOS: { adq: ['pagto', 'bruto', 'liquido'], erp: ['data', 'valor'] },
  /**
   * Layouts oficiais de liquidação, reconhecidos pela assinatura do cabeçalho (nomes normalizados).
   * grao 'venda' = uma linha por venda (casa por AUT/NSU + data) · 'lote' = loja × vencimento (casa por loja + período + mês).
   */
  LAYOUTS: [
    { id: 'getnet-detalhado', rotulo: 'Getnet · Vendas Detalhado', adquirente: 'GETNET', grao: 'venda', assinatura: ['NUMERODEAUTORIZACAOAUT', 'VALORLIQUIDO', 'DATAPREVISTADO1PAGAMENTO'],
      campos: { loja: ['ESTABELECIMENTOCOMERCIAL'], bandeira: ['BANDEIRA'], modalidade: ['FORMADEPAGAMENTO', 'MODALIDADE'], dataVenda: ['DATAHORADAVENDA', 'DATADAVENDA'], status: ['STATUSDATRANSACAO'],
        totalParcelas: ['PARCELAS'], pagto: ['DATAPREVISTADO1PAGAMENTO'], aut: ['NUMERODEAUTORIZACAOAUT'], nsu: ['NUMERODOCOMPROVANTEDEVENDASCV'], bruto: ['VALORBRUTO'], mdrV: ['VALORTAXA'], liquido: ['VALORLIQUIDO'] } },
    { id: 'credsystem-antecipados', rotulo: 'Credsystem · Antecipados', adquirente: 'CREDSYSTEM', bandeira: 'ESPOSENDE CARD', grao: 'lote', assinatura: ['VALORANT', 'RECEITAAN', 'VALORLIQ'],
      campos: { ec: ['LOJA'], loja: ['FANTASIA'], periodo: ['PERIODOVE'], liqBase: ['VALORLIQ'], venc: ['VENCIMENTO'], lote: ['NBAIXA'], pagto: ['PAGAMENTO'], antPct: ['TAXA'], nDias: ['NDIAS'],
        liquido: ['VALORANT'], antV: ['RECEITAAN'], forma: ['TIPOPGTO'] } },
  ],
  MODELOS: {
    erp: ['EMPRESA;LANÇAMENTO;VENCIMENTO;DOCUMENTO;COMPLEMENTO;VALOR;TAXA;VALOR LÍQUIDO;AUTORIZAÇÃO;OPERADORA;STATUS',
      '05-005 - CAMARAGIBE;23/09/2026;24/09/2026;CE244047-AV;DEBITO;32,99;0,23;32,76;965088;GETNET - MASTER;ABERTO',
      '05-005 - CAMARAGIBE;24/09/2026;26/10/2026;CE244205-1/6;PAR 1/06;24,99;0,41;24,58;M46119;GETNET - VISA;ABERTO',
      '05-005 - CAMARAGIBE;23/09/2026;24/09/2026;LOTE2016920012;;43,99;0,30;43,69;M46120;GETNET - MASTER;ABERTO',
      '05-005 - CAMARAGIBE;23/09/2026;24/09/2026;EC100231-AV;CREDITO;120,00;0,00;120,00;A77120;ESPOSENDE CARD;ABERTO'],
    adq: ['Adquirente;Bandeira;Estabelecimento;DataVenda;NSU;Autorizacao;Modalidade;Parcela;TotalParcelas;DataVencimentoOriginal;DataPagamento;ValorBrutoParcela;TaxaMDRValor;TaxaAntecipacaoValor;ValorLiquido',
      'GETNET;VISA;15105046;15/09/2026;123456;A1B2C3;Crédito parcelado;1;3;15/10/2026;16/09/2026;99,90;1,63;1,82;96,45'],
  },
  /** Matriz de células (1ª planilha / CSV inteiro). */
  async matriz(file) {
    if (/\.xlsx?$/i.test(file.name)) {
      const XLSX = await Libs.xlsx(), wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
      return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
    }
    const r = CSV.ler(CSV.decodificar(await file.arrayBuffer()));
    return [r.cabecalho, ...r.linhas.map(o => r.cabecalho.map(h => o[h]))];
  },
  /** Acha a linha de cabeçalho (o ERP traz um título na 1ª linha) e mapeia colunas → campos. */
  mapear(tipo, matriz) {
    const campos = this.CAMPOS[tipo]; let melhor = { i: -1, mapa: {}, n: 0 };
    for (let i = 0; i < Math.min(15, matriz.length); i++) {
      const nh = (matriz[i] || []).map((h, j) => [j, this.norm(h)]), mapa = {}, usados = new Set();
      for (const [campo, aliases] of Object.entries(campos))
        for (const a of aliases) { const h = nh.find(([j, n]) => n === a && !usados.has(j)); if (h) { mapa[campo] = h[0]; usados.add(h[0]); break; } }
      const n = Object.keys(mapa).length; if (n > melhor.n) melhor = { i, mapa, n };
    }
    return { ...melhor, faltando: this.OBRIGATORIOS[tipo].filter(c => melhor.mapa[c] == null) };
  },
  /** Procura um layout oficial nas 15 primeiras linhas. */
  layout(matriz) {
    for (let i = 0; i < Math.min(15, matriz.length); i++) {
      const nh = (matriz[i] || []).map(h => this.norm(h));
      for (const L of this.LAYOUTS) if (L.assinatura.every(a => nh.includes(a))) {
        const mapa = {}; for (const [c, al] of Object.entries(L.campos)) { const j = al.map(a => nh.indexOf(a)).find(j => j >= 0); if (j != null) mapa[c] = j; }
        return { L, i, mapa };
      }
    }
    return null;
  },
  async ler(tipo, file) {
    const mat = await this.matriz(file); if (mat.length < 2) throw new Error(`${file.name}: arquivo vazio.`);
    const lay = tipo === 'adq' ? this.layout(mat) : null;
    if (lay) {
      const linhas = [];
      for (let i = lay.i + 1; i < mat.length; i++) { const r = mat[i]; if (!r || !r.some(v => v !== '' && v != null)) continue; const o = {}; for (const [c, j] of Object.entries(lay.mapa)) o[c] = r[j]; linhas.push(o); }
      return { linhas, nome: file.name, mapa: lay.mapa, colunas: Object.keys(lay.mapa), layout: lay.L.id, layoutRotulo: lay.L.rotulo, adquirente: lay.L.adquirente, bandeira: lay.L.bandeira || '', grao: lay.L.grao };
    }
    const m = this.mapear(tipo, mat);
    if (m.faltando.length) throw new Error(`${file.name}: não encontrei as colunas ${m.faltando.map(c => `“${c}”`).join(', ')}. Baixe o modelo para ver os nomes aceitos.`);
    const idx = m.mapa, linhas = [];
    for (let i = m.i + 1; i < mat.length; i++) { const r = mat[i]; if (!r || !r.some(v => v !== '' && v != null)) continue; const o = {}; for (const [c, j] of Object.entries(idx)) o[c] = r[j]; linhas.push(o); }
    // sem layout oficial: a adquirente pode vir do nome do arquivo (ex.: "GETNET_…csv")
    const pelaNome = tipo === 'adq' && idx.adquirente == null ? Object.keys(ADQ_ALIASES_PADRAO).find(a => ADQ_ALIASES_PADRAO[a].some(x => AdqTaxas.chave(file.name.replace(/[_.]/g, ' ')).includes(x))) : null;
    return { linhas, nome: file.name, mapa: idx, colunas: Object.keys(idx), layout: 'generico', layoutRotulo: 'layout genérico', adquirente: pelaNome || '', bandeira: '', grao: 'parcela' };
  },
};

const MotorConciliacao = {
  r2: n => Math.round((Number(n) + Number.EPSILON) * 100) / 100,
  tick: () => new Promise(r => setTimeout(r, 0)),
  dias(a, b) { return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5); },
  somaDias(iso, n) { const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n)); return d.toISOString().slice(0, 10); },
  /** Janela de tolerância: D até D+1 útil. */
  janela(iso) { return [iso, DiasUteis.somar(iso, 1)]; },
  modalidade(txt) {
    const k = AdqTaxas.chave(txt);
    if (/DEB|ELECTRON|MAESTRO/.test(k)) return 'debito';
    if (/PIX/.test(k)) return 'pix';
    if (/VOUCHER|VALE|ALIMENT|REFEI|BENEF|TICKET|SODEXO|ALELO/.test(k)) return 'voucher';
    return 'credito';
  },
  indiceEC() {
    const m = new Map();
    Repo.todos('lojas').forEach(l => (l.adquirentes || []).forEach(a => { if (a.ec) m.set(String(a.ec).replace(/\D/g, ''), l.id); if (a.codigoLogico) m.set(AdqTaxas.chave(a.codigoLogico), l.id); }));
    return m;
  },
  /** "05-005 - CAMARAGIBE" → loja-005; EC da adquirente → loja; "014" → loja-014. */
  loja(txt, ec) {
    const s = String(txt ?? '').trim(); if (!s) return '';
    const m = s.match(/^\s*\d+\s*-\s*(\d{3})\b/); if (m && Repo.get('lojas', 'loja-' + m[1])) return 'loja-' + m[1];
    return ec.get(s.replace(/\D/g, '')) || ec.get(AdqTaxas.chave(s)) || Retaguarda.loja(s).lojaId || '';
  },
  dataISO(v) { return v instanceof Date ? Datas.iso(v) : Retaguarda.dataISO(v); },

  /** Parcelas do ERP (uma linha por parcela). LOTE no documento = recebimento de prestação. */
  async vendasERP(arq, adqPadrao, onLote = () => { }) {
    if (!arq) return { vendas: [], ignoradas: 0 };
    const ec = this.indiceEC(), out = []; let ignoradas = 0;
    for (let i = 0; i < arq.linhas.length; i++) {
      if (i && i % ADQ_CFG.lote === 0) { onLote(i / arq.linhas.length); await this.tick(); }
      const r = arq.linhas[i], data = this.dataISO(r.data), valor = Retaguarda.num(r.valor);
      if (!data || !(valor > 0)) { ignoradas++; continue; }
      const doc = String(r.documento ?? '').trim(), comp = String(r.complemento ?? '').trim(), prest = /LOTE/i.test(doc);
      const op = AdqTaxas.operadora([r.operadora || adqPadrao || '', r.bandeira || ''].join(' '));
      let parcela = 1, total = Retaguarda.num(r.totalParcelas) || 1, m;
      if ((m = comp.match(/PAR\w*\s*0*(\d+)\s*\/\s*0*(\d+)/i)) || (m = doc.match(/-0*(\d+)\s*\/\s*0*(\d+)\s*$/))) { parcela = +m[1]; total = +m[2]; }
      let modalidade = r.modalidade ? this.modalidade(r.modalidade) : /DEB/i.test(comp) ? 'debito' : /PIX/i.test(comp) ? 'pix' : /VOUCHER|VALE|ALIMENT|REFEI/i.test(comp) ? 'voucher' : (/CRED|PAR/i.test(comp) || m || /-AV\s*$/i.test(doc) && comp) ? 'credito' : prest ? 'debito' : 'credito';
      const venc = this.dataISO(r.venc) || this.somaDias(data, modalidade === 'debito' || modalidade === 'pix' ? 1 : 30 * parcela);
      out.push({ data, venc, loja: this.loja(r.loja, ec), lojaTxt: String(r.loja ?? '').trim(), adq: op.adq, adquirente: op.adquirente, bandeira: op.bandeira, tipo: prest ? 'prestacao' : 'venda',
        modalidade, parcela, total, valor, taxaErp: Retaguarda.num(r.taxa), liqErp: Retaguarda.num(r.liquido), doc, aut: String(r.aut ?? '').trim(), nsu: String(r.nsu ?? '').trim() });
    }
    return { vendas: out, ignoradas };
  },
  /** Nº da filial: "05-005 - CAMARAGIBE" → 5 · "20 - RUA DA PALMA" → 20 · "48- ESPOSENDE PATIO" → 48. */
  lojaNum(txt) { const s = String(txt ?? ''), m = s.match(/^\s*\d+\s*-\s*(\d{2,3})\b/) || s.match(/^\s*(\d+)/); return m ? +m[1] : null; },
  chaveAut: s => String(s ?? '').trim().toUpperCase().replace(/^0+(?=.)/, ''),
  /** "23/09/2026  a  23/09/2026" → ['2026-09-23', '2026-09-23']. */
  periodo(v) { const ds = String(v ?? '').match(/\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/g) || []; const a = this.dataISO(ds[0]), b = this.dataISO(ds[1] || ds[0]); return a ? [a, b && b >= a ? b : a] : null; },
  /**
   * Registros dos arquivos de liquidação (vários de uma vez: Getnet + Credsystem), em lotes.
   * grao 'venda' (Getnet detalhado) · 'lote' (Credsystem antecipados) · 'parcela' (layout genérico).
   */
  async registrosAdq(arqs, adqPadrao, onLote = () => { }) {
    const ec = this.indiceEC(), num = v => Retaguarda.num(v), dt = v => this.dataISO(v), out = [], ignoradas = [];
    const total = arqs.reduce((s, a) => s + a.linhas.length, 0) || 1; let feitos = 0;
    for (const arq of arqs) {
      const base = arq.adquirente || adqPadrao || '';
      for (let i = 0; i < arq.linhas.length; i++) {
        if (++feitos % ADQ_CFG.lote === 0) { onLote(feitos / total); await this.tick(); }
        const r = arq.linhas[i], linha = `${arq.nome}:${i + 2}`;
        if (arq.grao === 'lote') {
          const per = this.periodo(r.periodo), pagto = dt(r.pagto), liquido = num(r.liquido), liqBase = num(r.liqBase);
          if (!per || !pagto || !(liquido > 0)) { ignoradas.push(linha); continue; }
          const op = AdqTaxas.operadora([base, r.bandeira || arq.bandeira || ''].join(' ')), venc = dt(r.venc);
          out.push({ grao: 'lote', arq: arq.nome, adq: op.adq, adquirente: op.adquirente, bandeira: op.bandeira, lojaTxt: String(r.loja ?? '').trim(), lojaN: this.lojaNum(r.loja), loja: this.loja(r.loja, ec) || ec.get(String(r.ec ?? '').replace(/\D/g, '')) || '',
            ec: String(r.ec ?? '').trim(), dvIni: per[0], dvFim: per[1], venc, pagto, liqBase: liqBase ?? liquido, liquido, antV: r.antV != null && r.antV !== '' ? num(r.antV) : null, antPct: num(r.antPct), nDias: num(r.nDias), lote: String(r.lote ?? '').trim(), forma: String(r.forma ?? '').trim() });
          continue;
        }
        if (/CANCEL|NEGAD|ESTORN|DESFEIT/i.test(String(r.status ?? ''))) { ignoradas.push(linha); continue; }
        const bruto = num(r.bruto), liquido = num(r.liquido), pagto = dt(r.pagto);
        if (bruto == null || liquido == null || !pagto || bruto <= 0) { ignoradas.push(linha); continue; }
        const dataVenda = dt(r.dataVenda) || null, modalidade = this.modalidade(r.modalidade ?? ''), op = AdqTaxas.operadora([r.adquirente || base, r.bandeira || arq.bandeira || ''].join(' '));
        const mdrV = r.mdrV != null && r.mdrV !== '' ? Math.abs(num(r.mdrV)) : null, antV = r.antV != null && r.antV !== '' ? Math.abs(num(r.antV)) : null;
        const comum = { arq: arq.nome, adq: op.adq, adquirente: op.adquirente, bandeira: op.bandeira, loja: this.loja(r.loja, ec), lojaTxt: String(r.loja ?? '').trim(), dataVenda, nsu: String(r.nsu ?? '').trim(), aut: String(r.aut ?? '').trim(), modalidade, pagto, bruto, liquido, mdrV, antV };
        if (arq.grao === 'venda') { out.push({ ...comum, grao: 'venda', total: Math.max(1, num(r.totalParcelas) || 1) }); continue; }
        let parcela = num(r.parcela) || 1, tot = num(r.totalParcelas) || null;
        const pm = String(r.parcela ?? '').match(/^(\d+)\s*\/\s*(\d+)$/); if (pm) { parcela = +pm[1]; tot = +pm[2]; }
        tot ||= parcela;
        const venc = dt(r.venc) || (dataVenda ? this.somaDias(dataVenda, modalidade === 'debito' || modalidade === 'pix' ? 1 : 30 * parcela) : pagto);
        out.push({ ...comum, grao: 'parcela', parcela, total: tot, venc });
      }
    }
    return { registros: out, ignoradas };
  },
  banco() {
    const cred = [], porDoc = new Map();
    Repo.todos('extratos').forEach(d => {
      const tr = d.transacoes || [];
      tr.forEach(t => { if (t.valor > 0) cred.push({ id: d.id + '|' + t.id, data: t.data, valor: t.valor, hist: ' ' + AdqTaxas.chave(t.hist) + ' ', cat: DFC.classificar(t).categoria }); });
      const ds = tr.map(t => t.data).sort(); if (!ds.length) return;
      const k = d.contaId + '|' + d.mes, c = porDoc.get(k) || { ini: ds[0], fim: ds.at(-1) };
      c.ini = ds[0] < c.ini ? ds[0] : c.ini; c.fim = ds.at(-1) > c.fim ? ds.at(-1) : c.fim; porDoc.set(k, c);
    });
    const cobertura = [...porDoc.values()];
    cred.sort((a, b) => a.data.localeCompare(b.data));
    return { cred, coberto: iso => cobertura.some(c => iso >= c.ini && iso <= c.fim) };
  },
  /** Custo contratual de uma parcela. */
  custo(regra, modalidade, total, bruto, repasse, venc) {
    const taxa = AdqTaxas.mdr(regra, modalidade, total); if (taxa == null) return null;
    const mdr = bruto * taxa / 100, base = bruto - mdr;
    let ant = 0, dias = 0;
    if (regra.antecipado) {
      dias = Math.max(0, this.dias(repasse, venc)); const i = AdqTaxas.antecipacaoMes(regra);
      if (dias > 0 && i == null) return { semAntecipacao: true, taxa, mdr, ant: 0, dias };
      if (dias > 0) ant = regra.antecipacao?.metodo === 'composto' ? base * (1 - 1 / Math.pow(1 + i, dias / 30)) : base * i / 30 * dias;
    }
    return { taxa, mdr, ant, dias, liq: bruto - mdr - ant };
  },

  novoMes() {
    return { kpis: { volume: 0, volVenda: 0, volPrest: 0, nVenda: 0, nPrest: 0, parcelas: 0, bruto: 0, mdr: 0, antec: 0, liqEst: 0, mdrErp: 0, divergencia: 0, nDiv: 0, aMenor: 0, acima: 0, naoRepassado: 0, nFuros: 0, semOfx: 0, semTaxa: 0, nSemTaxa: 0, diasPond: 0, separado: true, recebido: 0, brutoTriplo: 0, brutoDireto: 0 },
      porAdq: {}, porRegra: {}, tipos: { venda: { n: 0, bruto: 0, mdr: 0, antec: 0, liq: 0 }, prestacao: { n: 0, bruto: 0, mdr: 0, antec: 0, liq: 0 } },
      erp: { vendas: 0, conciliadas: 0, erpSemAdq: 0, vErpSemAdq: 0, adqSemErp: 0, vAdqSemErp: 0, valorDif: 0, registros: 0 }, repasse: { grupos: 0, conciliados: 0, furos: 0, semOfx: 0, divergentes: 0, acima: 0, atrasados: 0 }, excecoes: [], repasses: [] };
  },
  /** Antecipação pro rata (simples) ou composta sobre a base, pelos dias entre o repasse e o vencimento original. */
  antecipacao(regra, base, dias, iMes) { if (!(dias > 0) || iMes == null) return 0; return regra?.antecipacao?.metodo === 'composto' ? base * (1 - 1 / Math.pow(1 + iMes, dias / 30)) : base * iMes / 30 * dias; },

  /**
   * Processa em lotes (sem travar a tela). Para cada adquirente + data de venda:
   *   com arquivo da adquirente → TRIPLO (ERP × adquirente × banco) · sem → DIRETO (ERP × banco, líquido estimado pelo contrato).
   * Aceita vários arquivos de liquidação ao mesmo tempo (Getnet + Credsystem). Retorna { modo, meses, avisos }.
   */
  async processar({ erp, adqs = [], adq = null, adqPadrao }, onProgresso = () => { }) {
    AdqTaxas.limparCache();
    if (adq && !adqs.length) adqs = [adq]; // compatibilidade (um único arquivo)
    const meses = {}, avisos = [], r2 = this.r2;
    const M = mes => meses[mes] ||= this.novoMes();
    const PA = (m, id) => m.porAdq[id] ||= { bruto: 0, venda: 0, prest: 0, mdr: 0, antec: 0, divergencia: 0, naoRepassado: 0, parcelas: 0, triplo: 0 };
    const PR = (m, adq, band) => m.porRegra[adq + '|' + band] ||= { adq, bandeira: band, bruto: 0, mdr: 0, antec: 0, mdrErp: 0, n: 0, semTaxa: 0 };
    const temAdq = adqs.length > 0;
    const { vendas, ignoradas: ignErp } = await this.vendasERP(erp, adqPadrao, f => onProgresso(f * (temAdq ? 0.15 : 0.3), 'Lendo o ERP'));
    if (ignErp) avisos.push(`${ignErp} linha(s) do ERP sem data ou valor foram ignoradas (ex.: linha de totais).`);
    const { registros, ignoradas: ignAdq } = temAdq ? await this.registrosAdq(adqs, adqPadrao, f => onProgresso(0.15 + f * 0.15, 'Lendo a liquidação das adquirentes')) : { registros: [], ignoradas: [] };
    if (ignAdq.length) avisos.push(`${ignAdq.length} linha(s) dos arquivos das adquirentes sem valor/data de pagamento (ou canceladas) foram ignoradas (ex.: ${ignAdq.slice(0, 3).join(', ')}).`);

    // cobertura: adquirente + data de venda presentes no(s) arquivo(s) de liquidação → modo triplo
    const cobertura = new Set();
    for (const p of registros) {
      if (p.grao === 'lote') for (let d = p.dvIni; d <= p.dvFim; d = this.somaDias(d, 1)) cobertura.add(p.adq + '|' + d);
      else if (p.dataVenda) cobertura.add(p.adq + '|' + p.dataVenda);
    }
    const coberto = v => cobertura.has(v.adq + '|' + v.data);
    const nCob = vendas.filter(coberto).length;
    const modo = !temAdq ? 'direto' : !vendas.length || nCob === vendas.length ? 'triplo' : nCob ? 'misto' : 'direto';
    if (temAdq && vendas.length && !nCob) avisos.push('Nenhuma venda do ERP está no período/adquirente dos arquivos de liquidação: todo o ERP foi auditado no modo direto.');

    const semRegra = new Map(), anotar = (chave, v) => semRegra.set(chave, (semRegra.get(chave) || 0) + v);
    const grupos = new Map(), G = (adqId, data) => { const k = adqId + '|' + data; return grupos.get(k) || grupos.set(k, { adq: adqId, data, total: 0, venda: 0, prest: 0, mdr: 0, antec: 0, n: 0, semTaxa: 0, est: false, direto: 0, triplo: 0, porLoja: new Map(), meses: new Map(), lotes: new Set() }).get(k); };
    const somaG = (g, valor, tipo, loja, mes) => { g.total += valor; g[tipo === 'prestacao' ? 'prest' : 'venda'] += valor; g.porLoja.set(loja, (g.porLoja.get(loja) || 0) + valor); g.meses.set(mes, (g.meses.get(mes) || 0) + valor); g.n++; };
    let feitos = 0; const totalPassos = (vendas.length + registros.length) * 1.2 + 1;
    const passo = async fase => { if (++feitos % ADQ_CFG.lote === 0) { onProgresso(0.3 + 0.6 * feitos / totalPassos, fase); await this.tick(); } };
    const idxAut = new Map(), idxLote = new Map(), push = (mp, k, v) => { const l = mp.get(k); if (l) l.push(v); else mp.set(k, [v]); };

    // ---------- 1) ERP: volume (venda × prestação) · modo direto para o que não tem liquidação ----------
    for (const v of vendas) {
      const mes = v.data.slice(0, 7), m = M(mes), k = m.kpis, a = PA(m, v.adq), pr = PR(m, v.adq, v.bandeira), tp = m.tipos[v.tipo];
      k.volume += v.valor; a.bruto += v.valor; pr.bruto += v.valor; pr.n++; tp.n++; tp.bruto += v.valor;
      if (v.tipo === 'prestacao') { k.volPrest += v.valor; k.nPrest++; a.prest += v.valor; } else { k.volVenda += v.valor; k.nVenda++; a.venda += v.valor; }
      if (v.taxaErp != null) { k.mdrErp += v.taxaErp; pr.mdrErp += v.taxaErp; }
      m.erp.vendas++;
      if (coberto(v)) { // fica para o cruzamento com a liquidação
        v.triplo = true; v.lojaN = this.lojaNum(v.lojaTxt); a.triplo += v.valor; k.brutoTriplo += v.valor;
        push(idxAut, [v.adq, this.chaveAut(v.aut), v.data].join('|'), v); if (v.nsu) push(idxAut, [v.adq, this.chaveAut(v.nsu), v.data].join('|'), v);
        push(idxLote, v.adq + '|' + v.lojaN, v);
        await passo('Indexando o ERP'); continue;
      }
      k.brutoDireto += v.valor;
      const regra = AdqTaxas.regra(v.adq, v.bandeira);
      const repasse = regra?.antecipado ? DiasUteis.somar(v.data, regra.prazoRepasse) : DiasUteis.proximo(v.venc);
      const c = regra ? this.custo(regra, v.modalidade, v.total, v.valor, repasse, v.venc) : null;
      const g = G(v.adq, repasse); g.est = true; g.direto++;
      let liq;
      if (!c || c.semAntecipacao) { // sem taxa na regra: usa o líquido do próprio ERP, sem antecipação, e sinaliza
        liq = v.liqErp ?? v.valor - (v.taxaErp || 0); k.semTaxa += v.valor; k.nSemTaxa++; g.semTaxa += v.valor; pr.semTaxa += v.valor;
        anotar(`${AdqTaxas.rotulo(v.adquirente, v.bandeira)} · ${ADQ_MODALIDADES[v.modalidade]} ${v.total}x${c?.semAntecipacao ? ' (sem taxa de antecipação)' : ''}`, v.valor);
        k.mdr += v.taxaErp || 0; a.mdr += v.taxaErp || 0; pr.mdr += v.taxaErp || 0; tp.mdr += v.taxaErp || 0;
      } else {
        liq = c.liq; k.mdr += c.mdr; k.antec += c.ant; a.mdr += c.mdr; a.antec += c.ant; pr.mdr += c.mdr; pr.antec += c.ant; tp.mdr += c.mdr; tp.antec += c.ant; k.diasPond += c.dias * v.valor; g.mdr += c.mdr; g.antec += c.ant;
      }
      k.bruto += v.valor; k.liqEst += liq; k.parcelas++; tp.liq += liq; a.parcelas++;
      somaG(g, liq, v.tipo, v.loja || v.lojaTxt, mes);
      await passo('Calculando MDR e antecipação pelo contrato');
    }

    // ---------- 2) TRIPLO: liquidação da adquirente × contrato × ERP ----------
    const excTaxa = (m, e) => { m.kpis.divergencia += e.dif; m.kpis.nDiv++; PA(m, e.adq).divergencia += e.dif; m.excecoes.push({ t: 'taxa', modo: 'triplo', ...e }); };
    const semAnt = new Map(), taxaDoArquivo = new Map(), lotesLoja = new Map(), atrasoEx = new Map(); let atrasados = 0;
    for (const p of registros) {
      const regra = AdqTaxas.regra(p.adq, p.bandeira), iRegra = AdqTaxas.antecipacaoMes(regra), rot = AdqTaxas.rotulo(p.adquirente, p.bandeira);

      if (p.grao === 'lote') { // ---- Credsystem: loja × vencimento antecipado (antecipação auditada linha a linha) ----
        const mes = p.dvIni.slice(0, 7), m = M(mes), k = m.kpis, a = PA(m, p.adq), pr = PR(m, p.adq, p.bandeira); m.erp.registros++;
        let iMes = iRegra;
        if (iMes == null && p.antPct != null) { iMes = p.antPct / 100; taxaDoArquivo.set(rot, p.antPct); }
        const dias = p.venc ? Math.max(0, this.dias(p.pagto, p.venc)) : (p.nDias || 0);
        const antecipa = regra ? regra.antecipado : true, antEsp = antecipa ? this.antecipacao(regra, p.liqBase, dias, iMes) : 0;
        const antCob = p.antV ?? r2(p.liqBase - p.liquido);
        k.recebido += p.liquido; k.diasPond += dias * p.liqBase; k.antec += antCob; a.antec += antCob; pr.antec += antCob; k.liqEst += p.liqBase - antEsp;
        const tp = m.tipos.venda; tp.antec += antCob; tp.liq += p.liquido;
        const esp = r2(p.liqBase - antEsp), dif = r2(esp - p.liquido);
        if (dif > ADQ_CFG.tolParcela) excTaxa(m, { adq: p.adq, band: p.bandeira, loja: p.loja, lojaTxt: p.lojaTxt, dv: p.dvIni, dp: p.pagto, venc: p.venc, nsu: p.lote ? `lote ${p.lote}` : '', parc: `antecipação ${dias} dia(s)`, mod: 'credito', tipo: 'venda', bruto: r2(p.liqBase), esp, real: r2(p.liquido), dif,
          det: `antecipação cobrada ${Fmt.brl(antCob)} × calculada ${Fmt.brl(antEsp)} (${Fmt.pct((iMes || 0) * 100)} a.m. · ${dias} dia(s) de ${Fmt.data(p.pagto)} a ${Fmt.data(p.venc)}) sobre ${Fmt.brl(p.liqBase)}` });
        else if (dif < -ADQ_CFG.tolParcela) k.aMenor += -dif;
        const ka = [p.adq, p.lojaN, p.dvIni, p.dvFim].join('|'), ag = lotesLoja.get(ka) || lotesLoja.set(ka, { p, mes, liqBase: 0, n: 0, pagto: new Set() }).get(ka); ag.liqBase += p.liqBase; ag.n++; ag.pagto.add(p.pagto);
        if (regra?.antecipado && p.pagto > DiasUteis.somar(p.dvFim, regra.prazoRepasse)) { atrasados++; m.repasse.atrasados++; atrasoEx.set(`${rot}: vendas de ${Fmt.data(p.dvFim)} pagas em ${Fmt.data(p.pagto)} (regra D+${regra.prazoRepasse})`, 1); }
        const g = G(p.adq, p.pagto); g.triplo++; g.lotes.add(p.lote); g.antec += antCob; somaG(g, p.liquido, 'venda', p.loja || p.lojaTxt, mes);
        await passo('Auditando a Credsystem'); continue;
      }

      // ---- venda (Getnet detalhado) ou parcela (layout genérico) ----
      const dv = p.dataVenda || p.pagto, mes = dv.slice(0, 7), m = M(mes), k = m.kpis, a = PA(m, p.adq), pr = PR(m, p.adq, p.bandeira); m.erp.registros++;
      let ev = null;
      const lista = [this.chaveAut(p.aut), this.chaveAut(p.nsu)].filter(Boolean).map(x => idxAut.get([p.adq, x, dv].join('|'))).find(l => l?.some(v => !v.casada)) || [];
      if (p.grao === 'venda') { // agrupa as parcelas do ERP da mesma venda (loja + documento) e fica com a de bruto mais próximo
        const porVenda = new Map(); lista.filter(v => !v.casada).forEach(v => { const kk = v.lojaTxt + '|' + v.doc.replace(/-(\d+\/\d+|AV)\s*$/i, ''); push(porVenda, kk, v); });
        ev = [...porVenda.values()].sort((x, y) => Math.abs(x.reduce((s, v) => s + v.valor, 0) - p.bruto) - Math.abs(y.reduce((s, v) => s + v.valor, 0) - p.bruto))[0] || null;
      } else { const v = lista.find(v => !v.casada && v.parcela === p.parcela); ev = v ? [v] : null; }
      const brutoErp = ev ? ev.reduce((s, v) => s + v.valor, 0) : 0, tipo = ev?.[0]?.tipo || 'venda';
      if (ev) { ev.forEach(v => v.casada = true); m.erp.conciliadas += ev.length; if (Math.abs(brutoErp - p.bruto) > 0.01) m.erp.valorDif++; }
      else if (vendas.length) { m.erp.adqSemErp++; m.erp.vAdqSemErp += p.bruto; }
      if (!vendas.length) { k.volume += p.bruto; a.bruto += p.bruto; pr.bruto += p.bruto; pr.n++; k.volVenda += p.bruto; k.nVenda++; a.venda += p.bruto; }
      const tp = m.tipos[tipo];
      const taxa = AdqTaxas.mdr(regra, p.modalidade, p.total), mdrCob = p.mdrV ?? (p.antV != null ? p.bruto - p.liquido - p.antV : p.bruto - p.liquido);
      k.bruto += p.bruto; k.parcelas++; a.parcelas++;
      k.mdr += mdrCob; a.mdr += mdrCob; pr.mdr += mdrCob; tp.mdr += mdrCob;
      // parcelas para a antecipação: as do ERP (vencimento original de cada uma) ou estimadas a partir do 1º pagamento
      const parcs = p.grao === 'parcela' ? [{ valor: p.bruto, venc: p.venc }]
        : ev ? ev.map(v => ({ valor: v.valor, venc: v.venc }))
        : Array.from({ length: p.total }, (_, i) => ({ valor: p.bruto / p.total, venc: this.somaDias(p.pagto, 30 * i) }));
      const somaP = parcs.reduce((s, x) => s + x.valor, 0) || 1, liqPos = p.liquido + (p.antV || 0); // líquido pós-MDR
      let antTot = 0;
      for (const x of parcs) {
        const liqP = liqPos * x.valor / somaP;
        let rep, ant = 0;
        if (regra?.antecipado) {
          rep = p.grao === 'parcela' ? p.pagto : DiasUteis.somar(dv, regra.prazoRepasse);
          const dias = Math.max(0, this.dias(rep, x.venc));
          if (p.antV != null) ant = p.antV * x.valor / somaP;
          else if (dias > 0 && iRegra == null) { semAnt.set(rot, (semAnt.get(rot) || 0) + liqP); }
          else ant = this.antecipacao(regra, liqP, dias, iRegra);
          k.diasPond += dias * x.valor;
        } else rep = p.grao === 'parcela' ? p.pagto : DiasUteis.proximo(x.venc);
        antTot += ant;
        const g = G(p.adq, rep); g.triplo++; if (p.antV == null && ant > 0) g.est = true; g.mdr += mdrCob * x.valor / somaP; g.antec += ant;
        somaG(g, liqP - (p.antV != null ? p.antV * x.valor / somaP : ant), tipo, p.loja || p.lojaTxt, mes);
      }
      k.antec += antTot; a.antec += antTot; pr.antec += antTot; tp.antec += antTot; tp.liq += liqPos - antTot; k.liqEst += liqPos - antTot; k.recebido += 0;
      if (p.mdrV == null) k.separado = false;
      if (taxa == null) { k.semTaxa += p.bruto; k.nSemTaxa++; pr.semTaxa += p.bruto; anotar(`${rot} · ${ADQ_MODALIDADES[p.modalidade]} ${p.total}x`, p.bruto); await passo('Auditando vendas da adquirente'); continue; }
      // Divergência de taxa: esperado = bruto − MDR contratual (− antecipação, quando o arquivo a traz); pago = líquido do arquivo
      const mdrC = p.bruto * taxa / 100, antCmp = p.antV != null ? this.antecipacao(regra, p.bruto - mdrC, regra?.antecipado ? Math.max(0, this.dias(p.pagto, p.grao === 'parcela' ? p.venc : parcs[0].venc)) : 0, iRegra) : 0;
      const esp = r2(p.bruto - mdrC - antCmp), dif = r2(esp - p.liquido);
      if (dif > ADQ_CFG.tolParcela) {
        const partes = [`MDR cobrado ${Fmt.brl(mdrCob)} (${Fmt.pct(mdrCob / p.bruto * 100, 2)}) × contratual ${Fmt.brl(mdrC)} (${Fmt.pct(taxa)})`];
        if (p.antV != null && p.antV - antCmp > 0.009) partes.push(`antecipação cobrada ${Fmt.brl(p.antV)} × calculada ${Fmt.brl(antCmp)}`);
        if (ev && ev[0].taxaErp != null) partes.push(`ERP registrou ${Fmt.brl(ev.reduce((s, v) => s + (v.taxaErp || 0), 0))}`);
        excTaxa(m, { adq: p.adq, band: p.bandeira, loja: p.loja || ev?.[0]?.loja || '', lojaTxt: ev?.[0]?.lojaTxt || p.lojaTxt, dv, dp: p.pagto, venc: p.grao === 'parcela' ? p.venc : '', nsu: p.aut || p.nsu, parc: p.grao === 'parcela' ? `${p.parcela}/${p.total}` : `${p.total}x`, mod: p.modalidade, tipo, bruto: r2(p.bruto), esp, real: r2(p.liquido), dif, det: partes.join(' · ') });
      } else if (dif < -ADQ_CFG.tolParcela) k.aMenor += -dif;
      await passo('Auditando vendas da adquirente');
    }
    // Credsystem · MDR por loja e período: soma do VALOR_LIQ × (bruto do ERP − MDR contratual). A Credsystem pode jogar a
    // 1ª parcela para o mês seguinte ao do ERP, por isso o cruzamento é da loja inteira no período, não mês a mês.
    for (const ag of lotesLoja.values()) {
      const p = ag.p, m = M(ag.mes), k = m.kpis, a = PA(m, p.adq), pr = PR(m, p.adq, p.bandeira), rot = AdqTaxas.rotulo(p.adquirente, p.bandeira);
      const rows = (idxLote.get(p.adq + '|' + p.lojaN) || []).filter(v => !v.casada && v.data >= p.dvIni && v.data <= p.dvFim);
      let brutoE = 0, mdrC = 0, prest = 0;
      for (const v of rows) {
        v.casada = true; brutoE += v.valor; if (v.tipo === 'prestacao') prest += v.valor;
        const tx = AdqTaxas.mdr(AdqTaxas.regra(v.adq, v.bandeira), v.modalidade, v.total);
        if (tx == null) { mdrC += v.taxaErp || 0; k.semTaxa += v.valor; k.nSemTaxa++; pr.semTaxa += v.valor; anotar(`${rot} · ${ADQ_MODALIDADES[v.modalidade]} ${v.total}x`, v.valor); } else mdrC += r2(v.valor * tx / 100);
      }
      m.erp.conciliadas += rows.length;
      const liqB = r2(ag.liqBase);
      if (!rows.length) { if (vendas.length) { m.erp.adqSemErp += ag.n; m.erp.vAdqSemErp += liqB; } k.bruto += liqB; continue; }
      const mdrCob = brutoE - liqB, liqEsp = r2(brutoE - mdrC), dif = r2(liqEsp - liqB), tol = Math.max(ADQ_CFG.tolParcela, rows.length * ADQ_CFG.tolArred);
      k.bruto += brutoE; k.parcelas += rows.length; a.parcelas += rows.length; k.mdr += mdrCob; a.mdr += mdrCob; pr.mdr += mdrCob; k.liqEst -= mdrC - mdrCob;
      m.tipos[prest > brutoE / 2 ? 'prestacao' : 'venda'].mdr += mdrCob;
      if (dif > tol) excTaxa(m, { adq: p.adq, band: p.bandeira, loja: p.loja, lojaTxt: p.lojaTxt, dv: p.dvIni, dp: [...ag.pagto][0], venc: '', nsu: p.lote ? `lote ${p.lote}` : '', parc: `MDR · ${rows.length} parcela(s)`, mod: 'credito', tipo: 'venda', bruto: r2(brutoE), esp: liqEsp, real: liqB, dif,
        det: `MDR cobrado ${Fmt.brl(mdrCob)} (${Fmt.pct(mdrCob / brutoE * 100, 2)}) × contratual ${Fmt.brl(mdrC)} (${Fmt.pct(mdrC / brutoE * 100, 2)}) · bruto do ERP ${Fmt.brl(brutoE)} × VALOR_LIQ ${Fmt.brl(liqB)} em ${ag.n} vencimento(s)${p.dvIni !== p.dvFim ? ` · vendas ${Fmt.data(p.dvIni)} a ${Fmt.data(p.dvFim)}` : ''}` });
      else if (dif < -tol) k.aMenor += -dif;
    }
    // ERP coberto sem liquidação correspondente
    const semLiq = [];
    vendas.forEach(v => { if (v.triplo && !v.casada) { const m = M(v.data.slice(0, 7)); m.erp.erpSemAdq++; m.erp.vErpSemAdq += v.valor; if (semLiq.length < 5) semLiq.push(`${v.lojaTxt} ${v.doc || v.aut} ${Fmt.brl(v.valor)}`); } });
    if (semLiq.length) avisos.push(`Parcelas do ERP sem correspondência no arquivo da adquirente (mesma data e adquirente): ${Object.values(meses).reduce((s, m) => s + m.erp.erpSemAdq, 0)} — ex.: ${semLiq.join('; ')}.`);
    if (taxaDoArquivo.size) avisos.push(`Sem taxa de antecipação na regra: usei a taxa declarada no arquivo (${[...taxaDoArquivo.entries()].map(([r, t]) => `${r} ${Fmt.pct(t)} a.m.`).join('; ')}). Cadastre a taxa negociada para auditar a antecipação.`);
    if (semAnt.size) avisos.push(`Sem taxa de antecipação na regra (repasse esperado sem desconto de antecipação): ${[...semAnt.keys()].join('; ')}.`);
    if (atrasados) avisos.push(`${atrasados} vencimento(s) antecipado(s) pagos depois do prazo da regra: ${[...atrasoEx.keys()].slice(0, 4).join('; ')}. Se esse é o prazo normal, ajuste o “prazo do repasse” da regra.`);

    // ---------- 3) repasse × banco: vendas + prestações somadas por adquirente e data de pagamento ----------
    onProgresso(0.92, 'Cruzando repasses com o extrato bancário'); await this.tick();
    const { cred, coberto: temOfx } = this.banco(), usados = new Set();
    const tolRep = v => Math.max(ADQ_CFG.tolRepasseAbs, v * ADQ_CFG.tolRepassePct), tolEst = v => Math.max(ADQ_CFG.tolEstAbs, v * ADQ_CFG.tolEstPct);
    const ordem = [...grupos.values()].sort((a, b) => a.data.localeCompare(b.data));
    /** Créditos da adquirente ainda livres com data em [de, ate] (ou (de, ate] quando incluiDe = false). */
    const candidatos = (g, de, ate, incluiDe = true) => {
      const al = AdqTaxas.aliasesAdq(g.adq), naJanela = cred.filter(c => !usados.has(c.id) && (incluiDe ? c.data >= de : c.data > de) && c.data <= ate);
      let cand = naJanela.filter(c => al.some(a => c.hist.includes(' ' + a + ' ')));
      if (!cand.length && g.adq !== AdqTaxas.adqId(ADQ_CREDSYSTEM)) cand = naJanela.filter(c => c.cat === 'rec_cartoes');
      return cand;
    };
    ordem.forEach(g => { g.total = r2(g.total); g.tol = g.est ? tolEst(g.total) : tolRep(g.total); g.modo = g.triplo ? 'triplo' : 'direto'; });
    // 1ª passada: um crédito = total do dia (primeiro em D, depois em D+1), para um dia sem crédito não "pegar" o do dia seguinte
    for (const lado of [0, 1]) for (const g of ordem) {
      if (g.match) continue; const [d0, d1] = this.janela(g.data);
      const c = (lado ? candidatos(g, d0, d1, false) : candidatos(g, d0, d0)).find(x => Math.abs(x.valor - g.total) <= g.tol);
      if (c) { g.match = c; usados.add(c.id); }
    }
    // 2ª passada (triplo): crédito loja a loja (ex.: Credsystem paga TED/DOC por filial)
    for (const g of ordem) {
      if (g.match || g.modo !== 'triplo' || g.porLoja.size < 2) continue; const [d0, d1] = this.janela(g.data), cs = candidatos(g, d0, d1), uso = [];
      for (const [, v] of g.porLoja) { const vv = r2(v), c = cs.find(x => !usados.has(x.id) && Math.abs(x.valor - vv) <= tolRep(vv)); if (c) { usados.add(c.id); uso.push(c); } }
      if (uso.length) g.uso = uso;
    }
    // 3ª/4ª passadas: todos os créditos da adquirente no próprio dia D; depois os que sobraram em D+1
    for (const lado of [0, 1]) for (const g of ordem) {
      if (g.match || g.uso) continue; const [d0, d1] = this.janela(g.data);
      const cs = lado ? candidatos(g, d0, d1, false) : candidatos(g, d0, d0); if (cs.length) { g.uso = cs; cs.forEach(c => usados.add(c.id)); }
    }
    for (const g of ordem) {
      const mesG = [...g.meses.entries()].sort((a, b) => b[1] - a[1])[0][0], m = M(mesG), k = m.kpis; m.repasse.grupos++;
      const [d0, d1] = this.janela(g.data), linhaRep = { adq: g.adq, data: g.data, modo: g.modo, total: g.total, venda: r2(g.venda), prest: r2(g.prest), lojas: g.porLoja.size, rec: 0, st: 'ok' }; m.repasses.push(linhaRep);
      if (!temOfx(d0) && !temOfx(d1)) { m.repasse.semOfx++; k.semOfx += g.total; linhaRep.st = 'semofx'; continue; }
      const composicao = `vendas ${Fmt.brl(g.venda)} + prestações ${Fmt.brl(g.prest)}`, uso = g.match ? [g.match] : g.uso || [], recebido = r2(uso.reduce((s, c) => s + c.valor, 0)); linhaRep.rec = recebido;
      if (g.modo === 'direto' || !temAdq) k.recebido += recebido; else k.recebido += 0; // no triplo o "recebido" já vem do arquivo
      const custo = g.modo === 'direto' ? `${g.n} parcela(s) · MDR ${Fmt.brl(g.mdr)} · antecipação ${Fmt.brl(g.antec)} (contrato)${g.semTaxa ? ` · ${Fmt.brl(g.semTaxa)} sem regra (líquido do ERP)` : ''}`
        : `${g.lotes.size ? `lote(s) ${[...g.lotes].filter(Boolean).slice(0, 3).join(', ')} · ` : ''}líquido informado pela adquirente${g.est ? ' − antecipação calculada pelo contrato' : ''}`;
      const base = { modo: g.modo, adq: g.adq, dp: g.data, esp: g.total, venda: r2(g.venda), prest: r2(g.prest), lojaTxt: `${g.porLoja.size} loja(s)` };
      if (g.match || Math.abs(recebido - g.total) <= g.tol) { m.repasse.conciliados++; await this.tick(); continue; }
      const creditos = uso.map(c => `${Fmt.data(c.data)} ${Fmt.brl(c.valor)}`).slice(0, 4).join(', ') + (uso.length > 4 ? '…' : '');
      linhaRep.st = !recebido ? 'furo' : recebido < g.total - g.tol ? (g.modo === 'direto' ? 'menor' : 'furo') : 'acima';
      if (!recebido) {
        m.repasse.furos++; k.naoRepassado += g.total; k.nFuros++; PA(m, g.adq).naoRepassado += g.total;
        m.excecoes.push({ t: 'repasse', ...base, real: 0, dif: g.total, det: `nenhum crédito de ${AdqTaxas.nome(g.adq)} no OFX entre ${Fmt.data(d0)} e ${Fmt.data(d1)} · ${composicao} · ${custo}` });
      } else if (recebido < g.total - g.tol) {
        const dif = r2(g.total - recebido);
        if (g.modo === 'direto') { // estimativa pelo contrato: crédito menor = divergência de taxa
          m.repasse.divergentes++; k.divergencia += dif; k.nDiv++; PA(m, g.adq).divergencia += dif;
          m.excecoes.push({ t: 'taxa', ...base, real: recebido, dif, det: `crédito no banco ${creditos} menor que o estimado pelo contrato · ${composicao} · ${custo}` });
        } else { // valor informado pela adquirente: o que faltou no banco é furo
          m.repasse.furos++; k.naoRepassado += dif; k.nFuros++; PA(m, g.adq).naoRepassado += dif;
          m.excecoes.push({ t: 'repasse', ...base, real: recebido, dif, det: `creditado ${creditos} até ${Fmt.data(d1)}, abaixo do valor a repassar · ${composicao} · ${custo}` });
        }
      } else { m.repasse.acima++; k.acima += r2(recebido - g.total); }
      await this.tick();
    }
    if (semRegra.size) avisos.push(`Sem taxa cadastrada (usado o líquido do ERP / não auditado): ${[...semRegra.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} (${Fmt.brl0(v)})`).join('; ')}${semRegra.size > 8 ? '…' : ''}.`);

    for (const m of Object.values(meses)) {
      const k = m.kpis;
      ['volume', 'volVenda', 'volPrest', 'bruto', 'mdr', 'antec', 'liqEst', 'mdrErp', 'divergencia', 'aMenor', 'acima', 'naoRepassado', 'semOfx', 'semTaxa', 'recebido', 'brutoTriplo', 'brutoDireto'].forEach(x => k[x] = r2(k[x]));
      k.prazoMedio = k.bruto ? Math.round(k.diasPond / k.bruto * 10) / 10 : 0; delete k.diasPond;
      [m.porAdq, m.porRegra].forEach(o => Object.values(o).forEach(a => Object.keys(a).forEach(x => { if (typeof a[x] === 'number') a[x] = r2(a[x]); })));
      Object.values(m.tipos).forEach(t => Object.keys(t).forEach(x => t[x] = r2(t[x])));
      ['vErpSemAdq', 'vAdqSemErp'].forEach(x => m.erp[x] = r2(m.erp[x]));
      m.excecoes.sort((a, b) => b.dif - a.dif);
      m.truncadas = Math.max(0, m.excecoes.length - ADQ_CFG.maxExcecoes); m.excecoes = m.excecoes.slice(0, ADQ_CFG.maxExcecoes);
      m.temErp = vendas.length > 0; m.temAdq = temAdq;
      m.modo = !temAdq ? 'direto' : !k.brutoDireto ? 'triplo' : k.brutoTriplo || m.erp.registros ? 'misto' : 'direto';
    }
    onProgresso(1, 'Concluído');
    return { modo, meses, avisos, vendas: vendas.length, parcelasAdq: registros.length, vendasBrutas: vendas };
  },

  async gravar(res, arquivos) {
    for (const [mes, m] of Object.entries(res.meses)) {
      if (!/^\d{4}-\d{2}$/.test(mes)) continue;
      const partes = Math.ceil(m.excecoes.length / ADQ_CFG.porDoc);
      for (let i = 0; i < partes; i++) await Repo.salvar('adq_excecoes', `${mes}_${i}`, { mes, parte: i, itens: m.excecoes.slice(i * ADQ_CFG.porDoc, (i + 1) * ADQ_CFG.porDoc) }, { modulo: 'retaguarda', semAudit: true });
      for (const d of Repo.todos('adq_excecoes').filter(d => d.mes === mes && d.parte >= partes)) await Repo.excluir('adq_excecoes', d.id, { modulo: 'retaguarda', rotulo: 'Exceções redistribuídas' });
      m.repasses.sort((a, b) => a.data.localeCompare(b.data) || a.adq.localeCompare(b.adq));
      await Repo.salvar('adq_auditorias', mes, { mes, modo: m.modo, temAdq: !!m.temAdq, repasses: m.repasses.slice(0, 400), kpis: m.kpis, porAdq: m.porAdq, porRegra: m.porRegra, tipos: m.tipos, erp: m.erp, repasse: m.repasse, temErp: m.temErp, nExcecoes: m.excecoes.length, truncadas: m.truncadas, partes, arquivos, processadoEm: new Date().toISOString(), processadoPor: Auth.id, avisos: res.avisos },
        { modulo: 'retaguarda', rotulo: 'Auditoria de adquirentes · ' + Retaguarda.mesLabel(mes), detalhe: `modo ${m.modo} · divergência ${Fmt.brl(m.kpis.divergencia)} · não repassado ${Fmt.brl(m.kpis.naoRepassado)}` });
    }
  },
  excecoes(mes) { return Repo.todos('adq_excecoes').filter(d => d.mes === mes).sort((a, b) => a.parte - b.parte).flatMap(d => d.itens || []); },
};

/* ============================ 7. UI (aba do Módulo 4) ============================ */
Retaguarda.ui.adq = { sub: 'painel', mes: '', tipo: '', adq: '', busca: '', pagina: 1, adqPadrao: '' };
Object.assign(Retaguarda, {
  _adqArq: { erps: [], adqs: [] }, _adqLista: [], _adqVendas: null, _adqErpUnido: null, _adqUltimo: null, _adqSeq: 0, _adqOcupado: false,
  mesesAdq() { const s = new Set([this.mesAtual(), ...Repo.todos('adq_auditorias').map(d => d.mes)]); return [...s].sort().reverse(); },
  renderAdq() {
    if (!Auth.can('retaguarda.adq.ver')) return this.bloqueado('Auditoria de Adquirentes', 'Taxas contratuais, vendas em cartão e repasses bancários são restritos ao perfil GESTOR.');
    if (!['adq_taxas', 'adq_auditorias', 'adq_excecoes', 'extratos', 'lojas'].every(c => Repo.prontas.has(c))) return '<div class="panel"><p class="muted">Carregando…</p></div>';
    const u = this.ui.adq;
    const seg = `<div class="seg" style="margin-bottom:14px" role="tablist">${[['painel', 'Painel do mês'], ['taxas', `Taxas contratuais (${AdqTaxas.regras().length} regras)`]].map(([k, r]) => `<button class="${u.sub === k ? 'on' : ''}" data-a="rt-adq-sub" data-v="${k}">${r}</button>`).join('')}</div>`;
    return seg + (u.sub === 'taxas' ? this.renderAdqTaxas() : this.renderAdqPainel());
  },
  /** Arquivos em memória: nome, adquirentes, período, linhas e botão remover. */
  listaArqAdq(tipo, fs) {
    const per = m => m.ini ? (m.ini === m.fim ? Fmt.data(m.ini) : `${Fmt.data(m.ini)} a ${Fmt.data(m.fim)}`) : '—';
    return `<ul class="adq-arqs">${fs.map(f => `<li><span><b>${esc(tipo === 'adq' ? (f.adquirente || 'adquirente?') : f.meta.adquirentes.join(' + ') || 'ERP')}</b>${tipo === 'adq' ? ` · ${esc(f.layoutRotulo)}` : ''} · ${f.meta.n.toLocaleString('pt-BR')} ${tipo === 'erp' ? 'parcelas' : f.grao === 'lote' ? 'lotes' : f.grao === 'venda' ? 'vendas' : 'parcelas'} · ${per(f.meta)}
        <span class="hint" style="display:block">${esc(f.nome)}${f.cedidas ? ` · ${f.cedidas} linha(s) substituída(s) por arquivo mais novo` : ''}</span></span>
      ${tipo === 'adq' && !f.adquirente ? `<select data-a="rt-adq-padrao" data-id="${f.id}" aria-label="Adquirente do arquivo"><option value="">Adquirente…</option>${AdqTaxas.adquirentes().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select>` : ''}
      <button class="iconbtn" data-a="rt-adq-limpar" data-t="${tipo}" data-id="${f.id}" aria-label="Remover ${esc(f.nome)}" title="Remover da memória" ${this._adqOcupado ? 'disabled' : ''}>${ICON.lixo}</button></li>`).join('')}</ul>`;
  },
  renderAdqPainel() {
    const u = this.ui.adq; if (!u.mes) u.mes = this.mesesAdq()[0];
    const a = Repo.get('adq_auditorias', u.mes), arq = this._adqArq, pode = Auth.can('retaguarda.adq.importar');
    const semTaxas = !AdqTaxas.regras().length, modo = arq.adqs.length ? (arq.erps.length ? 'misto' : 'triplo') : 'direto';
    const MODO = { direto: ['info', 'Modo direto: ERP × banco'], triplo: ['navy', 'Modo triplo: ERP × adquirente × banco'], misto: ['navy', 'Misto: triplo onde há liquidação, direto no resto'] };
    const imp = pode ? `<div class="panel" style="margin-bottom:16px"><div class="row between" style="align-items:flex-start"><div><h2>Importar arquivos</h2><p class="sub">Envie o ERP e, se tiver, os arquivos de liquidação (Getnet e Credsystem juntos). Datas e adquirentes sem liquidação são auditados no modo direto: líquido estimado pelo contrato × créditos do banco (OFX do Módulo 4).</p></div>
        <div class="row"><button class="btn ghost sm" data-a="rt-adq-modelo" data-t="erp">Modelo ERP</button><button class="btn ghost sm" data-a="rt-adq-modelo" data-t="adq">Modelo adquirente</button></div></div>
      ${semTaxas ? `<div class="note warn" style="margin-bottom:12px">Cadastre as regras de taxa (adquirente + bandeira) antes de processar. Se já carregou o ERP, use “Sugerir regras a partir do ERP” na aba de taxas. <button class="btn ghost sm" data-a="rt-adq-sub" data-v="taxas">Ir para taxas</button></div>` : ''}
      <div class="grid g3 adq-imp">
        <div class="upl ${arq.erps.length ? 'ok' : ''}"><span class="lbl">1 · Vendas Consolidadas (ERP)</span><label class="btn sec sm" style="cursor:pointer">${arq.erps.length ? 'Adicionar / substituir' : 'Escolher arquivos'}<input type="file" accept=".xlsx,.xls,.csv,.txt" multiple hidden data-a="rt-adq-arq" data-t="erp"></label>
          ${arq.erps.length ? this.listaArqAdq('erp', arq.erps) + (this._adqVendas ? `<span class="hint">${this._adqVendas.length} parcelas · ${this._adqVendas.filter(v => v.tipo === 'prestacao').length} prestação(ões) (LOTE)</span>` : '') : '<span class="hint">ex.: VENDASGETNET_ERP.XLSX + VENDASCREDSYSTEM_ERP.XLSX</span>'}</div>
        <div class="upl ${arq.adqs.length ? 'ok' : ''}"><span class="lbl">2 · Liquidação das adquirentes (opcional)</span><label class="btn sec sm" style="cursor:pointer">${arq.adqs.length ? 'Adicionar / substituir' : 'Escolher arquivos'}<input type="file" accept=".csv,.txt,.xlsx,.xls" multiple hidden data-a="rt-adq-arq" data-t="adq"></label>
          ${arq.adqs.length ? this.listaArqAdq('adq', arq.adqs) : '<span class="hint">ex.: Vendas_Detalhado (Getnet) + Antecipados - 610.csv (Credsystem) — pode enviar os dois</span>'}</div>
        <div class="upl"><span class="lbl">3 · Banco (OFX)</span><span class="hint">${Repo.todos('extratos').length ? `extratos de ${[...new Set(Repo.todos('extratos').map(d => d.mes))].sort().map(m => this.mesLabel(m)).join(', ')} (Módulo 4 → DFC)` : 'nenhum extrato: os repasses ficarão “sem OFX”'}</span>
          <span class="pill ${MODO[modo][0]}">${MODO[modo][1]}</span>
          <button class="btn" data-a="rt-adq-processar" ${this.temArqAdq() && !this._adqOcupado ? '' : 'disabled'}>Processar auditoria</button></div>
      </div>
      <p class="hint" style="margin:10px 0 0">Um arquivo novo das mesmas adquirentes e datas substitui o anterior na memória (sem duplicar registros). Os arquivos ficam em memória só enquanto esta aba estiver aberta.</p></div>` : '';
    const mem = this.temArqAdq(), ult = this._adqUltimo;
    const barra = pode && (mem || a) ? `<div class="adq-recalc" role="region" aria-label="Arquivos em memória">
      <div class="info">${mem ? `<b>Em memória:</b> ${arq.erps.length ? `ERP ${arq.erps.length} arquivo(s) · ${arq.erps.reduce((s, f) => s + f.meta.n, 0).toLocaleString('pt-BR')} linhas` : 'sem ERP'} · ${arq.adqs.length ? `liquidação ${arq.adqs.map(f => esc(f.adquirente || '?')).join(' + ')}` : 'sem liquidação'}${ult ? ` · último cálculo ${Fmt.dataHora(ult.em)} com ${ult.regras} regra(s)` : ''}`
        : '<span class="hint">Para recalcular com taxas novas, envie os arquivos de novo (a memória é limpa ao sair da aba).</span>'}</div>
      ${mem ? `<button class="btn ghost sm" data-a="rt-adq-liberar" ${this._adqOcupado ? 'disabled' : ''}>Limpar memória</button>` : ''}
      <button class="btn sec sm" data-a="rt-adq-recalcular" ${mem && !this._adqOcupado ? '' : 'disabled'} title="Relê as taxas contratuais e reprocessa os arquivos em memória">${ICON.atualizar}<span>Recalcular</span></button>
      <div id="adqProg" class="adq-prog" hidden><div class="bar"><i style="width:0%"></i></div><span class="hint" id="adqProgTxt"></span></div></div>` : '';
    const topo = `<div class="toolbar"><div class="field" style="max-width:240px"><label class="lbl" for="adqMes">Mês</label><select id="adqMes" data-a="rt-adq-f" data-k="mes">${this.mesesAdq().map(m => `<option value="${m}" ${m === u.mes ? 'selected' : ''}>${this.mesLabel(m)}${Repo.get('adq_auditorias', m) ? '' : ' · sem auditoria'}</option>`).join('')}</select></div></div>`;
    if (!a) return imp + topo + barra + `<div class="panel"><div class="empty">Nenhuma auditoria processada para ${this.mesLabel(u.mes)}. Envie o arquivo do ERP (e, se tiver, o da adquirente) e clique em “Processar auditoria”.</div></div>`;
    const k = a.kpis, direto = a.modo === 'direto', misto = a.modo === 'misto', pctV = (v, b) => b ? Fmt.pct(v / b * 100, 2) : '—', tp = a.tipos || { venda: {}, prestacao: {} };
    const kpis = `<div class="grid g5" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Volume transacionado</div><div class="v mono">${Fmt.brl0(k.volume)}</div><div class="d">vendas ${Fmt.brl0(k.volVenda)} · prestações ${Fmt.brl0(k.volPrest)}</div></div>
      <div class="kpi"><div class="k">Custo MDR</div><div class="v mono">${Fmt.brl0(k.mdr)}</div><div class="d">taxa efetiva ${pctV(k.mdr, k.bruto || k.volume)}${direto ? ` · contrato (ERP registrou ${Fmt.brl0(k.mdrErp)})` : misto ? ' · cobrado + estimado' : ' · cobrado pelas adquirentes'}</div></div>
      <div class="kpi"><div class="k">Custo de antecipação</div><div class="v mono">${Fmt.brl0(k.antec)}</div><div class="d">${pctV(k.antec, k.bruto || k.volume)} do volume · prazo médio ${Fmt.num(k.prazoMedio, 1)} dias${direto ? ' · estimado' : ''}</div></div>
      <div class="kpi zona-kpi ${k.divergencia ? 'bad' : 'ok'}"><div class="k">Divergência de taxas</div><div class="v mono" style="color:var(${k.divergencia ? '--bad' : '--ok'})">${Fmt.brl(k.divergencia)}</div><div class="d">${direto ? `${a.repasse.divergentes} dia(s) com crédito abaixo do estimado` : `${k.nDiv} registro(s) cobrado(s) a maior${k.aMenor ? ` · ${Fmt.brl0(k.aMenor)} a menor` : ''}`}</div></div>
      <div class="kpi zona-kpi ${k.naoRepassado ? 'bad' : 'ok'}"><div class="k">Valores não repassados</div><div class="v mono" style="color:var(${k.naoRepassado ? '--bad' : '--ok'})">${Fmt.brl(k.naoRepassado)}</div><div class="d">${a.repasse.furos} furo(s) em ${a.repasse.grupos} repasse(s)${k.semOfx ? ` · ${Fmt.brl0(k.semOfx)} sem OFX` : ''}</div></div></div>`;
    const avisos = [...(a.avisos || []), ...(a.truncadas ? [`${a.truncadas} exceção(ões) menores além das ${ADQ_CFG.maxExcecoes} maiores não foram guardadas.`] : [])].map(t => `<div class="note warn" style="margin-bottom:10px">${esc(t)}</div>`).join('');
    const linTipo = (rot, t, cls) => `<tr><td><span class="pill ${cls}">${rot}</span></td><td class="num">${t.n || 0}</td><td class="num">${Fmt.brl(t.bruto)}</td><td class="num">${Fmt.brl(t.mdr)}</td><td class="num">${Fmt.brl(t.antec)}</td><td class="num"><b>${Fmt.brl(t.liq)}</b></td></tr>`;
    const tipos = `<div class="panel" style="margin-bottom:16px"><h2>Venda × Prestação</h2><p class="sub">Documento com “LOTE” no ERP = recebimento de prestação (crediário pago no cartão). Na conciliação bancária os dois são somados por adquirente e data, porque o banco recebe um crédito único.${k.brutoTriplo && k.brutoDireto ? ` Com liquidação: ${Fmt.brl0(k.brutoTriplo)} · estimado pelo contrato: ${Fmt.brl0(k.brutoDireto)}.` : ''}</p>
      <div class="tbl-wrap"><table><thead><tr><th>Tipo</th><th class="num">Parcelas</th><th class="num">Bruto</th><th class="num">MDR</th><th class="num">Antecipação</th><th class="num">Líquido a receber</th></tr></thead><tbody>${linTipo('Venda', tp.venda, 'navy')}${linTipo('Prestação (LOTE)', tp.prestacao, 'info')}</tbody></table></div></div>`;
    const regras = Object.values(a.porRegra || {}).sort((x, y) => y.bruto - x.bruto);
    const resumo = `<div class="grid g2 cs-top adq-resumo" style="margin-bottom:16px">
      <div class="panel"><h2>Por adquirente e bandeira</h2><div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>Adquirente · bandeira</th><th class="num">Bruto</th><th class="num">MDR</th><th class="num">Antecipação</th>${direto ? '<th class="num">MDR no ERP</th>' : ''}</tr></thead><tbody>
        ${regras.map(x => `<tr><td class="cell-main">${esc(AdqTaxas.rotulo(AdqTaxas.nome(x.adq), x.bandeira))}${x.semTaxa ? ` <span class="pill warn" title="Sem regra de taxa">sem regra</span>` : ''}</td><td class="num">${Fmt.brl0(x.bruto)}</td><td class="num">${Fmt.brl0(x.mdr)}<div class="cell-sub">${pctV(x.mdr, x.bruto)}</div></td><td class="num">${Fmt.brl0(x.antec)}<div class="cell-sub">${pctV(x.antec, x.bruto)}</div></td>${direto ? `<td class="num">${Fmt.brl0(x.mdrErp)}<div class="cell-sub">${pctV(x.mdrErp, x.bruto)}</div></td>` : ''}</tr>`).join('')}</tbody></table></div></div>
      <div class="panel"><h2>Conciliação ${direto ? 'direta (ERP × banco)' : misto ? 'tripla + direta' : 'tripla'}</h2><div class="dl" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:12px">
        ${direto ? `<div><div class="t">Líquido estimado pelo contrato</div><div class="d">${Fmt.brl(k.liqEst)}</div></div><div><div class="t">Recebido no banco</div><div class="d">${Fmt.brl(k.recebido)}</div></div>`
          : `<div><div class="t">ERP × adquirente</div><div class="d">${a.temErp ? `${a.erp.conciliadas} parcela(s) do ERP casada(s) com ${a.erp.registros || 0} registro(s) da adquirente` : 'ERP não enviado'}</div></div><div><div class="t">ERP sem liquidação · adquirente sem ERP</div><div class="d" style="color:var(${a.erp.erpSemAdq || a.erp.adqSemErp ? '--warn' : '--ink'})">${a.temErp ? `${a.erp.erpSemAdq} (${Fmt.brl0(a.erp.vErpSemAdq)}) · ${a.erp.adqSemErp} (${Fmt.brl0(a.erp.vAdqSemErp)})` : '—'}</div></div>`}
        <div><div class="t">Repasses conferidos no OFX</div><div class="d">${a.repasse.conciliados} de ${a.repasse.grupos}${a.repasse.atrasados ? ` · ${a.repasse.atrasados} lote(s) pago(s) após o prazo` : ''}${a.repasse.acima ? ` · ${a.repasse.acima} acima do estimado (${Fmt.brl0(k.acima)})` : ''}</div></div>
        <div><div class="t">Repasses sem extrato</div><div class="d">${a.repasse.semOfx}${k.semOfx ? ` · ${Fmt.brl(k.semOfx)}` : ''}</div></div>
        <div><div class="t">Processado em</div><div class="d">${Fmt.dataHora(a.processadoEm)}</div></div>
        <div><div class="t">Arquivos</div><div class="d">${(a.arquivos || []).map(esc).join(' · ') || '—'}</div></div></div>
        <details class="log" style="margin-top:12px"><summary>Como o motor calcula</summary><div class="chg">Esperado = bruto − MDR (regra adquirente + bandeira × modalidade × parcelas) − antecipação. Com “100% antecipado”: repasse na venda + D+1 útil (ou o prazo da regra) e antecipação = (bruto − MDR) × taxa ao mês ÷ 30 × dias até o vencimento original de cada parcela. Sem a flag: só MDR, repasse no vencimento original.
          <br><b>Getnet</b>: casa com o ERP por autorização + data (soma as parcelas); o líquido do arquivo é pós-MDR e a antecipação sai no repasse. <b>Credsystem</b>: casa por loja + período de venda + mês do vencimento; compara VALOR_LIQ com o bruto do ERP − MDR e RECEITA_AN com a taxa da regra.
          <br>Divergência de taxa: pago abaixo do esperado em mais de ${Fmt.brl(ADQ_CFG.tolParcela)} por registro${direto || misto ? ` (no modo direto: crédito do dia abaixo do estimado em mais de ${Fmt.brl(ADQ_CFG.tolEstAbs)} ou ${Fmt.pct(ADQ_CFG.tolEstPct * 100, 2)})` : ''}. Furo de repasse: soma de vendas + prestações da adquirente no dia sem crédito correspondente no OFX até D+1 útil.</div></details></div></div>`;
    const exc = `<div class="panel"><div class="row between" style="margin-bottom:10px"><div><h2>Tabela de exceções</h2><p class="sub" style="margin:0">Furos e divergências de todas as adquirentes num só lugar: ${direto ? 'dias com crédito abaixo do estimado ou sem crédito no banco' : 'registros cobrados a maior e repasses que não chegaram ao banco'}.</p></div><button class="btn sec sm" data-a="rt-adq-exportar">Exportar CSV</button></div>
      <div class="toolbar"><div class="seg">${[['', `Todas (${a.nExcecoes})`], ['taxa', `Divergência de taxa (${direto ? a.repasse.divergentes : k.nDiv})`], ['repasse', `Furo de repasse (${a.repasse.furos})`]].map(([v, r]) => `<button class="${u.tipo === v ? 'on' : ''}" data-a="rt-adq-tipo" data-v="${v}">${r}</button>`).join('')}</div>
        ${Object.keys(a.porAdq).length > 1 ? `<div class="field"><label class="lbl" for="adqF">Adquirente</label><select id="adqF" data-a="rt-adq-f" data-k="adq"><option value="">Todas</option>${Object.keys(a.porAdq).map(id => `<option value="${id}" ${u.adq === id ? 'selected' : ''}>${esc(AdqTaxas.nome(id))}</option>`).join('')}</select></div>` : ''}
        <div class="field grow"><label class="lbl" for="adqBusca">Buscar</label><input id="adqBusca" type="search" value="${esc(u.busca)}" data-a="rt-adq-busca" placeholder="Loja, NSU, data…"></div></div>
      ${a.nExcecoes ? `<div class="tbl-wrap"><table id="adqTab"><thead><tr><th>Tipo</th><th>Adquirente · loja</th><th>${direto ? 'Repasse' : 'Venda / pagamento'}</th><th>${direto ? 'Venda · prestação' : 'NSU / lote · composição'}</th><th class="num">Esperado</th><th class="num">Pago / recebido</th><th class="num">Diferença</th><th>Detalhe</th></tr></thead><tbody id="adqBody"></tbody></table></div><div id="adqPager"></div>`
        : `<div class="empty">Nenhuma exceção neste mês${k.semOfx ? ' (repasses sem extrato bancário não entram)' : ''}.</div>`}</div>`;
    const ST = { ok: ['ok', 'Creditado'], semofx: ['', 'Sem OFX'], furo: ['bad', 'Furo'], menor: ['bad', 'Abaixo do estimado'], acima: ['info', 'Acima'] };
    const reps = (a.repasses || []).filter(r => !u.adq || r.adq === u.adq);
    const repTab = reps.length ? `<div class="panel" style="margin-bottom:16px"><h2>Repasses por adquirente e data</h2><p class="sub">Líquido de vendas + prestações (LOTE) que deveria cair no banco em cada data (D a D+1 útil) × créditos do OFX.</p>
      <div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Adquirente</th><th class="num">Vendas</th><th class="num">Prestações</th><th class="num">A receber</th><th class="num">No banco</th><th>Situação</th></tr></thead><tbody>
      ${reps.map(r => `<tr><td class="mono">${Fmt.data(r.data)}</td><td class="cell-main">${esc(AdqTaxas.nome(r.adq))}<div class="cell-sub">${r.modo === 'direto' ? 'estimado pelo contrato' : 'pela liquidação'} · ${r.lojas} loja(s)</div></td><td class="num">${Fmt.brl(r.venda)}</td><td class="num">${Fmt.brl(r.prest)}</td><td class="num"><b>${Fmt.brl(r.total)}</b></td><td class="num">${r.st === 'semofx' ? '—' : Fmt.brl(r.st === 'ok' && !r.rec ? r.total : r.rec)}</td><td><span class="pill ${ST[r.st][0]}">${ST[r.st][1]}</span></td></tr>`).join('')}</tbody></table></div></div>` : '';
    return imp + topo + avisos + barra + kpis + tipos + resumo + repTab + exc;
  },
  montarAdq() {
    const tb = $('#adqBody'); if (!tb) return;
    const u = this.ui.adq, q = AdqTaxas.chave(u.busca);
    const lista = this._adqLista = MotorConciliacao.excecoes(u.mes).filter(e => (!u.tipo || e.t === u.tipo) && (!u.adq || e.adq === u.adq)
      && (!q || AdqTaxas.chave([e.nsu, e.lojaTxt, e.loja && this.nomeLoja(e.loja), e.dv, e.dp, e.det].join(' ')).includes(q)));
    const POR = 50, pags = Math.max(1, Math.ceil(lista.length / POR)); u.pagina = Math.min(Math.max(1, u.pagina), pags);
    const i0 = (u.pagina - 1) * POR, fatia = lista.slice(i0, i0 + POR);
    const tpl = document.createElement('template');
    tpl.innerHTML = fatia.map(e => `<tr><td>${e.t === 'taxa' ? '<span class="pill bad">Divergência de taxa</span>' : '<span class="pill warn">Furo de repasse</span>'}</td>
      <td><div class="cell-main">${esc(e.band && e.band !== '*' ? AdqTaxas.rotulo(AdqTaxas.nome(e.adq), e.band) : AdqTaxas.nome(e.adq))}</div><div class="cell-sub">${esc(e.loja ? this.nomeLoja(e.loja) : e.lojaTxt || '—')}</div></td>
      ${e.modo === 'direto' ? `<td class="mono">${Fmt.data(e.dp)}</td><td class="mono">${Fmt.brl(e.venda)}<div class="cell-sub">prestações ${Fmt.brl(e.prest)}</div></td>`
        : `${e.t === 'repasse' || e.dv == null ? `<td class="mono">${Fmt.data(e.dp)}<div class="cell-sub">repasse</div></td><td class="mono">${Fmt.brl(e.venda)}<div class="cell-sub">prestações ${Fmt.brl(e.prest)}</div></td>`
          : `<td class="mono">${Fmt.data(e.dv)}<div class="cell-sub">pago ${Fmt.data(e.dp)}${e.venc && e.venc !== e.dp ? ` · venc. ${Fmt.data(e.venc)}` : ''}</div></td><td class="mono">${esc(e.nsu || '—')}${e.parc ? `<div class="cell-sub">${esc(e.parc)} · ${esc(ADQ_MODALIDADES[e.mod] || '')}${e.tipo === 'prestacao' ? ' · prestação' : ''}</div>` : ''}</td>`}`}
      <td class="num">${Fmt.brl(e.esp)}</td><td class="num">${Fmt.brl(e.real)}</td><td class="num"><b style="color:var(--bad)">${Fmt.brl(e.dif)}</b></td>
      <td class="cell-sub" style="min-width:280px;max-width:420px">${esc(e.det || '')}</td></tr>`).join('') || '<tr><td colspan="8"><div class="empty">Nenhuma exceção com esse filtro.</div></td></tr>';
    const frag = document.createDocumentFragment(); frag.appendChild(tpl.content); tb.replaceChildren(frag);
    UI.rotularTabelas(tb.closest('.tbl-wrap'));
    const pg = $('#adqPager'), tot = lista.reduce((s, e) => s + e.dif, 0);
    if (pg) pg.innerHTML = lista.length > POR ? `<div class="row between" style="margin-top:10px"><span class="hint">Linhas ${i0 + 1}–${i0 + fatia.length} de ${lista.length} · ${Fmt.brl(tot)}</span><div class="row"><button class="btn sec sm" data-a="rt-adq-pag" data-d="-1" ${u.pagina <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="hint">Página ${u.pagina} de ${pags}</span><button class="btn sec sm" data-a="rt-adq-pag" data-d="1" ${u.pagina >= pags ? 'disabled' : ''}>Próxima ›</button></div></div>`
      : `<p class="hint" style="margin-top:10px">${lista.length} exceção(ões) · ${Fmt.brl(tot)}</p>`;
  },

  /* ---------------- taxas: regras por adquirente + bandeira ---------------- */
  resumoMdr(r) {
    return (r.mdr || []).filter(f => f.taxa != null && f.taxa !== '').map(f => `${f.modalidade === 'debito' ? 'déb.' : f.modalidade === 'credito' ? (f.de === f.ate ? `créd. ${f.de}x` : `créd. ${f.de}–${f.ate}x`) : ADQ_MODALIDADES[f.modalidade]} ${Fmt.pct(f.taxa)}`).join(' · ') || '<span style="color:var(--warn)">sem MDR</span>';
  },
  renderAdqTaxas() {
    const pode = Auth.can('retaguarda.adq.taxas'), regs = AdqTaxas.regras(), adqs = AdqTaxas.adquirentes(), temErp = !!this._adqVendas?.length;
    const antTxt = r => !r.antecipado ? '<span class="hint">só MDR (repasse no vencimento)</span>' : r.antecipacao?.taxa != null && r.antecipacao.taxa !== '' ? `${Fmt.pct(r.antecipacao.taxa)} ${r.antecipacao.unidade === 'aa' ? 'a.a.' : 'a.m.'} · ${r.antecipacao.metodo === 'composto' ? 'composto' : 'simples'} · repasse D+${r.prazoRepasse}` : '<span style="color:var(--warn)">taxa de antecipação não informada</span>';
    return `<div class="panel"><div class="row between"><div><h2>Regras de taxa: adquirente + bandeira</h2><p class="sub">Cada regra tem o MDR por modalidade e nº de parcelas e o parâmetro “100% antecipado”. A regra “todas as bandeiras” vale quando não houver uma específica.</p></div>
        ${pode ? `<div class="row"><button class="btn ghost" data-a="rt-adq-sugerir" ${temErp ? '' : 'disabled title="Carregue o arquivo do ERP no painel do mês"'}>Sugerir regras a partir do ERP</button><button class="btn" data-a="rt-adq-regra-nova">+ Regra</button></div>` : ''}</div>
      ${adqs.map(n => { const rs = regs.filter(r => r.adquirente === n), nativo = n === ADQ_CREDSYSTEM;
        return `<div class="panel" style="padding:16px;margin-top:12px"><div class="row between"><div><h2 style="font-size:15px">${esc(n)}${nativo ? ' <span class="pill navy">Esposende Card (cartão próprio)</span>' : ''}</h2><p class="hint" style="margin:2px 0 0">No extrato bancário: ${AdqTaxas.aliasesAdq(AdqTaxas.adqId(n)).map(esc).join(', ')}</p></div>
          ${pode ? `<button class="btn sec sm" data-a="rt-adq-regra-nova" data-n="${esc(n)}">+ Regra ${nativo ? '' : '(bandeira)'}</button>` : ''}</div>
          ${rs.length ? `<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>Adquirente - operadora/bandeira</th><th>100% antecipado</th><th>Antecipação</th><th>MDR</th>${pode ? '<th></th>' : ''}</tr></thead><tbody>
            ${rs.map(r => `<tr><td class="cell-main">${esc(AdqTaxas.rotulo(r.adquirente, r.bandeira))}</td>
              <td>${pode ? `<label class="check"><input type="checkbox" data-a="rt-adq-antecip" data-id="${r.id}" ${r.antecipado ? 'checked' : ''}> ${r.antecipado ? 'sim' : 'não'}</label>` : r.antecipado ? 'sim' : 'não'}</td>
              <td>${antTxt(r)}</td><td class="cell-sub">${this.resumoMdr(r)}</td>
              ${pode ? `<td class="acts"><button class="iconbtn" data-a="rt-adq-regra-editar" data-id="${r.id}" aria-label="Editar regra">${ICON.editar}</button><button class="iconbtn" data-a="rt-adq-regra-del" data-id="${r.id}" aria-label="Remover regra">${ICON.lixo}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`
          : `<div class="empty" style="margin-top:10px;padding:18px">${nativo ? 'Configure CREDSYSTEM - ESPOSENDE CARD: MDR, “100% antecipado”, taxa de antecipação e como o crédito aparece no banco.' : 'Nenhuma regra.'}</div>`}</div>`; }).join('')}
    </div>`;
  },
  abrirAdqRegra(id, pre = {}) {
    const r = id ? AdqTaxas.norm(Repo.get(AdqTaxas.COL, id)) : { adquirente: pre.adquirente || '', bandeira: pre.bandeira || '*', antecipado: true, prazoRepasse: 1, aliases: pre.adquirente === ADQ_CREDSYSTEM ? ['CREDSYSTEM'] : [], antecipacao: { taxa: '', unidade: 'am', metodo: 'simples' }, mdr: pre.mdr || ADQ_FAIXAS_PADRAO.map(f => ({ ...f })) };
    const bands = [['*', 'Todas as bandeiras'], ...[...new Set(ADQ_BANDEIRAS.map(b => b[1]))].map(b => [b, b])];
    const linha = (f, i) => `<tr data-i="${i}"><td><select name="mod_${i}" aria-label="Modalidade">${Object.entries(ADQ_MODALIDADES).map(([k, rr]) => `<option value="${k}" ${f.modalidade === k ? 'selected' : ''}>${rr}</option>`).join('')}</select></td>
      <td><input type="number" name="de_${i}" min="1" max="24" value="${f.de ?? 1}" aria-label="Parcelas de" style="max-width:80px"></td><td><input type="number" name="ate_${i}" min="1" max="24" value="${f.ate ?? 1}" aria-label="Parcelas até" style="max-width:80px"></td>
      <td><input type="number" step="0.0001" min="0" name="tx_${i}" value="${f.taxa ?? ''}" placeholder="ex.: 1,63" aria-label="Taxa MDR %" style="max-width:110px"></td><td><button type="button" class="iconbtn" data-del-faixa aria-label="Remover faixa">${ICON.lixo}</button></td></tr>`;
    UI.modal({
      titulo: id ? `Regra · ${AdqTaxas.rotulo(r.adquirente, r.bandeira)}` : 'Nova regra de taxa', largo: true,
      corpo: `<div class="form-grid">
        <div class="field"><label class="lbl" for="rg_adq">Adquirente</label><input id="rg_adq" name="adquirente" list="rgAdqs" value="${esc(r.adquirente)}" ${id ? 'readonly' : ''} required placeholder="Ex.: GETNET"><datalist id="rgAdqs">${AdqTaxas.adquirentes().map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
        ${campo('Operadora / bandeira', 'bandeira', r.bandeira, { opcoes: bands, attrs: id ? 'disabled' : '' })}
        <div class="field full"><label class="check" style="font-weight:600"><input type="checkbox" name="antecipado" ${r.antecipado ? 'checked' : ''}> 100% Antecipado</label><span class="hint" style="margin-top:4px">Marcado: o motor calcula a antecipação pelos dias entre o repasse e o vencimento original de cada parcela. Desmarcado: aplica só o MDR e espera o repasse no vencimento.</span></div>
        ${campo('Taxa de antecipação (%)', 'ant_taxa', r.antecipacao?.taxa ?? '', { tipo: 'number', attrs: 'step="0.0001" min="0" placeholder="ex.: 1,79"' })}
        <div class="field"><span class="lbl">Unidade e método</span><div class="row" style="flex-wrap:nowrap"><select name="ant_unidade" aria-label="Unidade"><option value="am" ${r.antecipacao?.unidade !== 'aa' ? 'selected' : ''}>ao mês (a.m.)</option><option value="aa" ${r.antecipacao?.unidade === 'aa' ? 'selected' : ''}>ao ano (a.a.)</option></select>
          <select name="ant_metodo" aria-label="Método"><option value="simples" ${r.antecipacao?.metodo !== 'composto' ? 'selected' : ''}>juros simples (pro rata)</option><option value="composto" ${r.antecipacao?.metodo === 'composto' ? 'selected' : ''}>juros compostos</option></select></div></div>
        ${campo('Prazo do repasse antecipado (dias úteis após a venda)', 'prazoRepasse', r.prazoRepasse ?? 1, { tipo: 'number', attrs: 'min="0" max="30"' })}
        ${campo('Como o crédito aparece no extrato (separado por vírgula)', 'aliases', (r.aliases || []).join(', '), { dica: 'Ex.: GETNET, SANTANDER GETNET · ESPOSENDE CARD' })}</div>
        <h3 style="font-size:14px;margin:16px 0 8px">MDR por modalidade e nº de parcelas</h3>
        <div class="tbl-wrap"><table class="nolabel matriz"><thead><tr><th>Modalidade</th><th>De</th><th>Até</th><th>MDR (%)</th><th></th></tr></thead><tbody id="faixas">${(r.mdr || []).map(linha).join('')}</tbody></table></div>
        <button type="button" class="btn sec sm" style="margin-top:8px" data-add-faixa>+ Faixa</button>`,
      aoAbrir: m => {
        let n = (r.mdr || []).length;
        m.addEventListener('click', e => {
          if (e.target.closest('[data-add-faixa]')) { const tpl = document.createElement('template'); tpl.innerHTML = linha({ modalidade: 'credito', de: 2, ate: 6, taxa: '' }, n++); $('#faixas', m).appendChild(tpl.content); }
          const d = e.target.closest('[data-del-faixa]'); if (d) d.closest('tr').remove();
        });
      },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar regra', acao: async m => {
        const f = UI.lerForm(m), adquirente = AdqTaxas.chave(f.adquirente || r.adquirente), bandeira = id ? r.bandeira : (f.bandeira && f.bandeira !== '*' ? f.bandeira : adquirente === ADQ_CREDSYSTEM ? ADQ_ESPOSENDE_CARD : '*');
        if (!adquirente) { UI.toast('Informe o adquirente.'); return false; }
        const mdr = $$('#faixas tr', m).map(tr => { const i = tr.dataset.i; return { modalidade: f['mod_' + i], de: Number(f['de_' + i]) || 1, ate: Number(f['ate_' + i]) || Number(f['de_' + i]) || 1, taxa: f['tx_' + i] == null ? null : Number(f['tx_' + i]) }; });
        if (mdr.some(x => x.ate < x.de)) { UI.toast('Em cada faixa, “até” deve ser maior ou igual a “de”.'); return false; }
        if (!id && Repo.get(AdqTaxas.COL, AdqTaxas.idRegra(adquirente, bandeira))?.ativo !== false && Repo.get(AdqTaxas.COL, AdqTaxas.idRegra(adquirente, bandeira))) { UI.toast('Já existe regra para esse adquirente e bandeira.'); return false; }
        await AdqTaxas.salvar(id, { adquirente, bandeira, antecipado: !!$('[name="antecipado"]', m).checked, prazoRepasse: Number(f.prazoRepasse) || 0, aliases: String(f.aliases || '').split(',').map(s => s.trim()).filter(Boolean), antecipacao: { taxa: f.ant_taxa, unidade: f.ant_unidade, metodo: f.ant_metodo }, mdr });
        UI.toast('Regra salva');
      } }],
    });
  },
  /** Cria as regras que faltam (adquirente + bandeira) com o MDR mais frequente lançado no ERP. */
  async sugerirRegrasAdq() {
    const sug = AdqTaxas.sugerir(this._adqVendas || []), exist = new Set(AdqTaxas.regras().map(r => r.adquirente + '|' + r.bandeira));
    const novas = sug.filter(s => !exist.has(s.adquirente + '|' + s.bandeira));
    if (!novas.length) return UI.toast('Todas as bandeiras do ERP já têm regra.');
    const corpo = `<p style="margin-top:0">Taxas mais frequentes na coluna TAXA do ERP (só vendas; prestações ficam fora). Serão criadas <b>${novas.length}</b> regra(s) com “100% antecipado” marcado e a taxa de antecipação <b>em branco</b> — informe a taxa negociada depois.</p>
      <div class="tbl-wrap"><table class="nolabel"><thead><tr><th>Adquirente · bandeira</th><th>MDR observado</th></tr></thead><tbody>${novas.map(s => `<tr><td>${esc(AdqTaxas.rotulo(s.adquirente, s.bandeira))}</td><td class="cell-sub">${s.mdr.map(f => `${f.modalidade === 'debito' ? 'déb.' : f.de === f.ate ? `créd. ${f.de}x` : `créd. ${f.de}–${f.ate}x`} ${Fmt.pct(f.taxa)} (${f.n})`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>`;
    if (!(await UI.confirmar('Sugerir regras a partir do ERP', corpo, 'Criar regras'))) return;
    for (const s of novas) await AdqTaxas.salvar(null, { adquirente: s.adquirente, bandeira: s.bandeira, antecipado: true, prazoRepasse: 1, aliases: [], antecipacao: { taxa: '', unidade: 'am', metodo: 'simples' }, mdr: s.mdr.map(({ n, ...f }) => f) });
    UI.toast(`${novas.length} regra(s) criada(s). Informe a taxa de antecipação de cada uma.`);
  },

  /* ---------------- ações ---------------- */
  /* ---------------- estado em memória (RAM) dos arquivos importados ----------------
     Vive só enquanto a aba "Auditoria de Adquirentes" estiver aberta: liberarAdq() é chamado ao trocar de aba
     ou sair do Módulo 4. Cada arquivo guarda as linhas lidas e, por linha, as chaves adquirente|data (_ks),
     usadas para substituir dados quando chega um arquivo mais novo das mesmas adquirentes e datas. */
  liberarAdq() {
    const a = this._adqArq; if (!a.erps.length && !a.adqs.length && !this._adqVendas && !this._adqLista.length) return;
    this._adqArq = { erps: [], adqs: [] }; this._adqVendas = null; this._adqLista = []; this._adqErpUnido = null; this._adqUltimo = null; this._adqSeq = 0;
  },
  temArqAdq() { return this._adqArq.erps.length > 0 || this._adqArq.adqs.length > 0; },
  /** ERP único para o motor (os arquivos em memória concatenados), memorizado até a lista mudar. */
  erpUnido() {
    const es = this._adqArq.erps; if (!es.length) return null;
    return this._adqErpUnido ||= { nome: es.map(f => f.nome).join(' + '), linhas: es.flatMap(f => f.linhas), mapa: es[0].mapa, colunas: es[0].colunas };
  },
  /** Chaves adquirente|data de cada linha (em lotes, sem travar a tela) + período e adquirentes do arquivo. */
  async chavesArqAdq(tipo, f) {
    const M = MotorConciliacao, adqs = new Set(), base = f.adquirente || '';
    let ini = '', fim = '';
    for (let i = 0; i < f.linhas.length; i++) {
      if (i && i % ADQ_CFG.lote === 0) await M.tick();
      const r = f.linhas[i]; let op, ds = [];
      if (tipo === 'erp') { op = AdqTaxas.operadora([r.operadora || this.ui.adq.adqPadrao || '', r.bandeira || ''].join(' ')); const d = M.dataISO(r.data); if (d && Retaguarda.num(r.valor) > 0) ds = [d]; }
      else if (f.grao === 'lote') { op = AdqTaxas.operadora([base, r.bandeira || f.bandeira || ''].join(' ')); const p = M.periodo(r.periodo); if (p && M.dataISO(r.pagto)) for (let d = p[0]; d <= p[1]; d = M.somaDias(d, 1)) ds.push(d); }
      else { op = AdqTaxas.operadora([r.adquirente || base, r.bandeira || f.bandeira || ''].join(' ')); const d = M.dataISO(r.dataVenda) || M.dataISO(r.pagto); if (d && Retaguarda.num(r.bruto) > 0) ds = [d]; }
      // adquirente ainda não identificada: chave própria do arquivo, para dois arquivos sem adquirente não se substituírem por engano
      const pre = tipo === 'adq' && !base && !r.adquirente ? '?' + f.nome : op.adq;
      r._ks = ds.map(d => pre + '|' + d);
      if (ds.length) { adqs.add(op.adquirente); if (!ini || ds[0] < ini) ini = ds[0]; if (!fim || ds.at(-1) > fim) fim = ds.at(-1); }
    }
    f.meta = { adquirentes: [...adqs].sort(), ini, fim, n: f.linhas.filter(r => r._ks.length).length };
  },
  /**
   * Substituição inteligente: o arquivo novo prevalece. Arquivo com o mesmo nome é trocado inteiro; nos demais do mesmo
   * tipo, as linhas das MESMAS adquirentes e datas do novo saem da memória (sem duplicar no cruzamento).
   * Um arquivo antigo que fica sem linhas úteis é descartado. Devolve o que foi substituído, para o aviso na tela.
   */
  integrarArqAdq(tipo, novo) {
    const lista = tipo === 'erp' ? this._adqArq.erps : this._adqArq.adqs, notas = [];
    const novas = new Set(novo.linhas.flatMap(r => r._ks));
    for (const f of [...lista]) {
      if (f.nome === novo.nome) { lista.splice(lista.indexOf(f), 1); notas.push(`${f.nome} (versão anterior) substituído`); continue; }
      const antes = f.linhas.length; f.linhas = f.linhas.filter(r => !r._ks.some(k => novas.has(k)));
      const saiu = antes - f.linhas.length; if (!saiu) continue;
      if (!f.linhas.some(r => r._ks.length)) { lista.splice(lista.indexOf(f), 1); notas.push(`${f.nome} substituído (mesmas adquirentes e datas)`); }
      else { f.cedidas = (f.cedidas || 0) + saiu; this.metaArqAdq(f); notas.push(`${saiu} linha(s) de ${f.nome} trocada(s) pelo arquivo novo`); }
    }
    novo.id = ++this._adqSeq; novo.lidoEm = new Date().toISOString(); novo.substituiu = notas; lista.push(novo);
    if (tipo === 'erp') this._adqErpUnido = null;
    return notas;
  },
  /** Recalcula período e nº de linhas úteis depois de uma substituição parcial (datas saem das chaves adq|AAAA-MM-DD). */
  metaArqAdq(f) {
    const ds = f.linhas.flatMap(r => r._ks.map(k => k.slice(-10))).sort();
    f.meta = { ...f.meta, ini: ds[0] || '', fim: ds.at(-1) || '', n: f.linhas.filter(r => r._ks.length).length };
  },
  async atualizarVendasAdq() { const e = this.erpUnido(); this._adqVendas = e ? (await MotorConciliacao.vendasERP(e, this.ui.adq.adqPadrao)).vendas : null; },
  async lerArquivoAdq(tipo, files) {
    const msgs = [];
    for (const file of files) {
      try {
        const f = await LeitorArquivosAdq.ler(tipo, file);
        await this.chavesArqAdq(tipo, f);
        if (!f.meta.n) { msgs.push(`${file.name}: nenhuma linha com data e valor.`); continue; }
        const notas = this.integrarArqAdq(tipo, f);
        msgs.push(`${f.nome}: ${f.meta.n} linha(s)${tipo === 'adq' ? ` · ${f.adquirente || 'adquirente não identificada'} · ${f.layoutRotulo}` : ''}${notas.length ? ` — ${notas.join('; ')}` : ''}`);
      } catch (e) { msgs.push(e.message); }
    }
    if (tipo === 'erp') await this.atualizarVendasAdq();
    if (msgs.length) UI.toast(msgs.join(' | '));
    App.render();
  },
  removerArqAdq(tipo, id) {
    const lista = tipo === 'erp' ? this._adqArq.erps : this._adqArq.adqs, i = lista.findIndex(f => f.id === id); if (i < 0) return;
    const [f] = lista.splice(i, 1); f.linhas = null; // solta as linhas para o coletor de lixo
    if (tipo === 'erp') { this._adqErpUnido = null; this.atualizarVendasAdq().then(() => App.render()); }
    UI.toast(`${f.nome} removido da memória.`); App.render();
  },
  async processarAdq(recalculo = false) {
    if (this._adqOcupado) return;
    const arq = this._adqArq; if (!this.temArqAdq()) return UI.toast('Nenhum arquivo em memória: envie o ERP e/ou os arquivos das adquirentes.');
    const semAdq = arq.adqs.find(f => !f.adquirente && f.mapa.adquirente == null); if (semAdq) return UI.toast(`Escolha a adquirente do arquivo ${semAdq.nome}.`);
    const prog = $('#adqProg'), bar = prog?.querySelector('i'), txt = $('#adqProgTxt'), btns = $$('[data-a="rt-adq-processar"], [data-a="rt-adq-recalcular"]');
    const status = (f, t) => { if (bar) bar.style.width = Math.round(f * 100) + '%'; if (txt) txt.textContent = t; };
    this._adqOcupado = true; if (prog) prog.hidden = false; btns.forEach(b => { b.disabled = true; b.classList.add('girando'); });
    const t0 = performance.now();
    try {
      if (recalculo) { status(0, 'Lendo as taxas contratuais atualizadas…'); try { await Repo.recarregar(AdqTaxas.COL); } catch (e) { console.warn('recarregar taxas', e); } }
      const adqs = arq.adqs.slice(), erp = this.erpUnido(); // retrato da memória: remover um arquivo durante o cálculo não afeta esta rodada
      const res = await MotorConciliacao.processar({ adqs, erp, adqPadrao: this.ui.adq.adqPadrao }, (f, fase) => status(f, `${fase}… ${Math.round(f * 100)}%`));
      status(1, 'Gravando resultados…');
      Sync.ocupado(true);
      try { await MotorConciliacao.gravar(res, [...arq.erps.map(f => f.nome), ...adqs.map(f => f.nome)]); } finally { Sync.ocupado(false); }
      const meses = Object.keys(res.meses).filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
      if (!recalculo || !meses.includes(this.ui.adq.mes)) this.ui.adq.mes = meses.at(-1) || this.ui.adq.mes;
      this.ui.adq.pagina = 1;
      this._adqUltimo = { em: new Date().toISOString(), regras: AdqTaxas.regras().length, modo: res.modo, meses };
      UI.toast(`${recalculo ? 'Recalculado com as taxas atuais' : 'Auditoria concluída'} (${{ direto: 'ERP × banco', triplo: 'tripla', misto: 'tripla + direta' }[res.modo]}) em ${Math.round((performance.now() - t0) / 100) / 10}s: ${res.vendas} linhas do ERP${res.parcelasAdq ? `, ${res.parcelasAdq} registros das adquirentes` : ''} · ${meses.map(m => this.mesLabel(m)).join(', ')}.`);
    } catch (e) { console.error(e); UI.toast('Falha na auditoria: ' + (e.message || e)); }
    finally { this._adqOcupado = false; }
    App.render();
  },
  exportarAdq() {
    const cab = ['Tipo', 'Modo', 'Adquirente', 'Bandeira', 'Loja', 'Data venda', 'Data repasse/pagamento', 'Vencimento original', 'NSU/Autorização', 'Parcela', 'Modalidade', 'Vendas (líq.)', 'Prestações (líq.)', 'Esperado', 'Pago/recebido', 'Diferença', 'Detalhe'];
    const n = v => v == null ? '' : String(v).replace('.', ',');
    const linhas = (this._adqLista || []).map(e => [e.t === 'taxa' ? 'Divergência de taxa' : 'Furo de repasse', e.modo || '', AdqTaxas.nome(e.adq), e.band && e.band !== '*' ? e.band : '', e.loja ? this.nomeLoja(e.loja) : e.lojaTxt || '', e.dv || '', e.dp || '', e.venc || '', e.nsu || '', e.parc || '', ADQ_MODALIDADES[e.mod] || '', n(e.venda), n(e.prest), n(e.esp), n(e.real), n(e.dif), e.det || '']);
    Documento.baixarArquivo(`excecoes_adquirentes_${this.ui.adq.mes}.csv`, new Blob(['\uFEFF' + CSV.gerar([cab, ...linhas], ';')], { type: 'text/csv' }));
  },
  async acaoAdq(a, el) {
    const u = this.ui.adq;
    switch (a) {
      case 'rt-adq-sub': u.sub = el.dataset.v; return App.render();
      case 'rt-adq-tipo': u.tipo = el.dataset.v; u.pagina = 1; return App.render();
      case 'rt-adq-pag': u.pagina += Number(el.dataset.d); this.montarAdq(); return $('#adqTab')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      case 'rt-adq-processar': return this.processarAdq(false);
      case 'rt-adq-recalcular': return this.processarAdq(true);
      case 'rt-adq-limpar': return this.removerArqAdq(el.dataset.t, Number(el.dataset.id));
      case 'rt-adq-liberar': this.liberarAdq(); UI.toast('Arquivos removidos da memória.'); return App.render();
      case 'rt-adq-exportar': return this.exportarAdq();
      case 'rt-adq-modelo': { const t = el.dataset.t; return Documento.baixarArquivo(`modelo_${t === 'erp' ? 'vendas_erp' : 'liquidacao_adquirente'}.csv`, new Blob(['\uFEFF' + LeitorArquivosAdq.MODELOS[t].join('\r\n') + '\r\n'], { type: 'text/csv' })); }
      case 'rt-adq-regra-nova': return this.abrirAdqRegra(null, { adquirente: el.dataset.n || '' });
      case 'rt-adq-regra-editar': return this.abrirAdqRegra(el.dataset.id);
      case 'rt-adq-regra-del': { const r = AdqTaxas.norm(Repo.get(AdqTaxas.COL, el.dataset.id)); if (!(await UI.confirmar('Remover regra', `Remover a regra ${esc(AdqTaxas.rotulo(r.adquirente, r.bandeira))}?`, 'Remover', true))) return; return AdqTaxas.remover(el.dataset.id); }
      case 'rt-adq-sugerir': return this.sugerirRegrasAdq();
    }
  },
  async mudancaAdq(a, el) {
    if (a === 'rt-adq-f') { this.ui.adq[el.dataset.k] = el.value; this.ui.adq.pagina = 1; return App.render(); }
    if (a === 'rt-adq-padrao') { // adquirente escolhida para um arquivo genérico: recalcula as chaves e aplica a substituição
      const lista = this._adqArq.adqs, f = lista.find(x => x.id === Number(el.dataset.id)); if (!f) return;
      f.adquirente = el.value; await this.chavesArqAdq('adq', f); lista.splice(lista.indexOf(f), 1); const notas = this.integrarArqAdq('adq', f);
      if (notas.length) UI.toast(notas.join('; ')); return App.render();
    }
    if (a === 'rt-adq-antecip') { const { id, ...x } = Repo.get(AdqTaxas.COL, el.dataset.id); await AdqTaxas.salvar(el.dataset.id, { ...AdqTaxas.norm({ ...x, id }), id: undefined, adq: undefined, antecipado: el.checked }); return UI.toast(el.checked ? '100% antecipado: antecipação calculada pelos dias' : 'Só MDR: repasse no vencimento original'); }
    if (a === 'rt-adq-arq') { const fs = [...el.files]; el.value = ''; if (fs.length) return this.lerArquivoAdq(el.dataset.t, fs); }
  },
});
