/* =====================================================================
   MÓDULO 3 — CONTRATOS DE LOCAÇÃO E OUTROS (repositório central de contratos e apólices)
   Camadas:
     5 Repositório  → ContratosLocacao   (tabela GLOBAL contratos_locacao, só GESTOR: regra do banco admin/admin)
                       • matriz()  = todos os documentos (locação, apólices, outros) + contratos antigos que ainda
                                     estão só no cadastro da loja (lojas.contrato, ainda não migrados)
                       • todos()/ativos() = só LOCAÇÃO — é o que o Motor de Aluguel (FCX) consome, sem mudança
     6 Serviços     → RadarRenovatoria   (zonas pela Lei 8.245/91, art. 51 §5º, sobre a matriz global)
                       LeitorContratoIA   (PDF → texto [PdfTexto, Util] → IA [IA.executar] → JSON;
                                           CONTRATO_PROMPT para contratos, APOLICE_PROMPT para apólices)
     7 UI           → Contratos          (Módulo 3: radar no topo, lista única, formulário com leitor por IA)

   MODELO contratos_locacao/<ct-xxxx>  (o nome da coleção ficou por compatibilidade: é a tabela global)
     comum: { id, tipo 'locacao'|'seguro'|'outro' (ausente = locacao), status 'Ativo'|'Inativo',
              data_inicio, data_vencimento 'AAAA-MM-DD', observacoes?, arquivo?, extracaoIA?, criadoEm/Por… }
     locacao: loja_id → rh_centros (centro de custo da loja), loja_ref? → lojas (quando criado pelo M2),
              locador, indice_reajuste, valor_atual (aluguel mínimo R$/mês), percentual_faturamento,
              condominio?, fundo_promocao?, garantia?, data_base_reajuste?, historico_reajustes[]?
     seguro:  seguradora, numero_apolice, ramo, segurado?, corretora?, lojas_ids[] (filiais cobertas),
              coberturas[{nome, limite, franquia}], premios{liquido, adicional, iof, total},
              pagamento{forma, parcelas, valor_parcela, primeiro_vencimento, vencimentos[], observacao}
     outro:   contraparte, objeto, lojas_ids[]?, valor_atual? (R$/mês), indice_reajuste?
     • Exclusão é lógica (status "Inativo"): o histórico fica.
     • Locação: um centro de custo (ou loja) tem no máximo um contrato Ativo.
   ===================================================================== */
const CT_STATUS = ['Ativo', 'Inativo'];
const CT_INDICES = ['IGP-M', 'IPCA', 'INPC', 'IVAR', 'Fixo (sem índice)'];
const CT_TIPOS = { locacao: 'Locação', seguro: 'Apólice de seguro', outro: 'Outro contrato' };
const CT_RAMOS = ['Empresarial / Patrimonial', 'Responsabilidade Civil', 'Roubo de valores', 'Seguro-fiança locatícia', 'Vida em grupo', 'Frota / Automóvel', 'Outro'];
const CT_POR_PAGINA = 25, RADAR_LINHAS = 12;

/** Prompt do Leitor de Contratos: a IA atua como analista jurídico e devolve só JSON. */
const CONTRATO_PROMPT = `Você é analista jurídico especializado em locação comercial (Lei 8.245/91) da Esposende, rede de lojas de calçados do Nordeste (lojas de rua, shopping e hipermercado).
Leia o CONTRATO DE LOCAÇÃO abaixo (com aditivos, se houver) e extraia os dados cadastrais.
Responda APENAS com um objeto JSON válido, sem texto antes ou depois, exatamente neste formato:
{"locador":"nome ou razão social do LOCADOR (se for administradora/shopping assinando como locadora, use esse nome; mais de um locador: separe por ' e ')",
"data_inicio":"AAAA-MM-DD",
"data_vencimento":"AAAA-MM-DD",
"indice_reajuste":"IGP-M | IPCA | INPC | IVAR | Fixo | outro índice citado",
"valor_atual":0.0,
"percentual_faturamento":0.0,
"imovel":"identificação do imóvel/loja: shopping, nº da loja/LUC, endereço, cidade",
"prazo_meses":0,
"confianca":{"locador":"alta|media|baixa","data_inicio":"alta|media|baixa","data_vencimento":"alta|media|baixa","indice_reajuste":"alta|media|baixa","valor_atual":"alta|media|baixa","percentual_faturamento":"alta|media|baixa"},
"evidencias":{"locador":"trecho curto do contrato","data_inicio":"","data_vencimento":"","indice_reajuste":"","valor_atual":"","percentual_faturamento":""},
"observacoes":"pontos que o gestor deve conferir (aditivos, aluguel percentual, carência, escalonamento)"}
Regras:
- Datas sempre em AAAA-MM-DD. Se o contrato trouxer só o prazo (ex.: "60 meses a contar de 01/03/2022"), calcule data_vencimento como o último dia do prazo (28/02/2027).
- Havendo aditivo que prorrogue o prazo ou altere o aluguel, use o dado mais recente e registre em observacoes.
- valor_atual = aluguel mensal fixo/mínimo vigente, em reais, como número (ex.: 12500.5). Não some condomínio, fundo de promoção, IPTU, 13º aluguel nem res sperata. Se houver escalonamento, use o valor do período atual e explique. Se o aluguel for só percentual do faturamento, use null e explique.
- percentual_faturamento = % do faturamento bruto da loja cobrado como aluguel percentual (comum em shopping: paga-se o maior entre o mínimo e o percentual), como número (ex.: 6 para 6%). Sem cláusula de aluguel percentual: null.
- indice_reajuste: use o nome do índice como aparece (IGP-M/FGV, IPCA/IBGE, INPC, IVAR); "Fixo" se não houver reajuste por índice.
- Se o documento NÃO for de locação (prestação de serviço, comodato, manutenção…), use em "locador" a outra parte contratante e explique o objeto em observacoes.
- Não invente: se um dado não constar, use null e confiança "baixa".`;

/** Prompt do Leitor de Apólices: coberturas, prêmios e condições de pagamento. */
const APOLICE_PROMPT = `Você é analista de seguros empresariais da Esposende, rede de lojas de calçados do Nordeste (lojas de rua, shopping e hipermercado).
Leia a APÓLICE DE SEGURO abaixo (com endossos, se houver) e extraia os dados cadastrais.
Responda APENAS com um objeto JSON válido, sem texto antes ou depois, exatamente neste formato:
{"seguradora":"nome da seguradora","numero_apolice":"","ramo":"Empresarial / Patrimonial | Responsabilidade Civil | Roubo de valores | Seguro-fiança locatícia | Vida em grupo | Frota / Automóvel | Outro",
"segurado":"razão social do segurado","corretora":"",
"data_inicio":"AAAA-MM-DD","data_vencimento":"AAAA-MM-DD",
"coberturas":[{"nome":"nome da cobertura (ex.: Incêndio, raio e explosão)","limite":0.0,"franquia":"texto da franquia/POS ou null"}],
"premios":{"liquido":0.0,"adicional_fracionamento":0.0,"iof":0.0,"total":0.0},
"carencias":[{"cobertura":"cobertura ou situação a que se aplica","prazo":"ex.: 30 dias a partir do início da vigência","detalhe":"condição resumida"}],
"condicoes_pagamento":{"forma":"boleto | débito em conta | cartão de crédito | à vista","parcelas":0,"valor_parcela":0.0,"primeiro_vencimento":"AAAA-MM-DD","vencimentos":["AAAA-MM-DD"],"observacao":"juros, desconto à vista, carência de cobertura por atraso"},
"locais_segurados":["endereço ou identificação de cada local de risco (loja, shopping, cidade)"],
"confianca":{"seguradora":"alta|media|baixa","vigencia":"alta|media|baixa","coberturas":"alta|media|baixa","premios":"alta|media|baixa","condicoes_pagamento":"alta|media|baixa"},
"evidencias":{"vigencia":"trecho curto","premios":"","condicoes_pagamento":""},
"observacoes":"pontos que o gestor deve conferir (exclusões relevantes, franquias altas, prazo de aviso de sinistro, endossos)"}
Regras:
- Valores em reais como número (ex.: 1250.75). limite = limite máximo de indenização (LMI) da cobertura.
- Liste TODAS as coberturas contratadas da apólice (básica e adicionais), com o LMI de cada uma.
- Em carencias, liste os períodos de carência e as suspensões de cobertura (por exemplo, por atraso no pagamento do prêmio). Sem carência na apólice, use [].
- Se houver vários locais de risco, liste cada um em locais_segurados (eles serão associados às filiais).
- Não invente: se um dado não constar, use null.`;

/* ============================ 5. REPOSITÓRIO ============================ */
const ContratosLocacao = {
  COL: 'contratos_locacao',
  tipo(c) { return c?.tipo || 'locacao'; },
  dataValida(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Datas.de(s)); },
  /** Todos os documentos da tabela global (locação, apólices e outros). */
  global({ inativos = true } = {}) { return Repo.todos(this.COL).filter(c => inativos || c.status !== 'Inativo'); },
  /** Só LOCAÇÃO — consumido pelo Motor de Aluguel / FCX (comportamento da v12 preservado). */
  todos({ inativos = true } = {}) { return this.global({ inativos }).filter(c => this.tipo(c) === 'locacao'); },
  ativos() { return this.todos({ inativos: false }); },
  seguros({ inativos = true } = {}) { return this.global({ inativos }).filter(c => this.tipo(c) === 'seguro'); },
  /** Apólices ativas associadas a uma filial (lojas_ids). */
  segurosDaLoja(lojaId) { return this.seguros({ inativos: false }).filter(c => (c.lojas_ids || []).includes(lojaId)).sort((a, b) => (a.data_vencimento || '').localeCompare(b.data_vencimento || '')); },
  get(id) { return id ? Repo.get(this.COL, id) : null; },
  /** Centros de custo que representam lojas ("014 - SHOPPING TACARUNA I"). */
  centrosDeLoja() { return RH.lista('centros', { inativos: true }).filter(c => /^\d{3}\s*-/.test(c.nome.trim())); },
  lojaDoCentro(cc) { const m = cc && cc.nome.trim().match(/^(\d{3})\s*-/); return m ? Repo.get('lojas', 'loja-' + m[1]) : null; },
  centroDaLoja(l) { return l && this.centrosDeLoja().find(c => c.nome.trim().startsWith(l.codigo + ' -') || new RegExp('^0*' + Number(l.codigo) + '\\s*-').test(c.nome.trim())) || null; },
  lojaDoContrato(c) { return c.loja_ref ? Repo.get('lojas', c.loja_ref) : c.loja_id ? this.lojaDoCentro(RH.get('centros', c.loja_id)) : null; },
  nomeLoja(id) { const l = Repo.get('lojas', id); return l ? `${l.codigo} · ${l.nome}` : id; },
  rotuloLojas(ids = []) { return !ids.length ? 'nenhuma filial' : ids.length <= 2 ? ids.map(i => this.nomeLoja(i)).join(', ') : `${ids.length} filiais`; },
  rotuloLoja(c) {
    const t = this.tipo(c);
    if (t !== 'locacao') return this.rotuloLojas(c.lojas_ids || []);
    const cc = c.loja_id && RH.get('centros', c.loja_id); if (cc) return RH.rotulo(cc);
    const l = c.loja_ref && Repo.get('lojas', c.loja_ref); return l ? `${l.codigo} - ${l.nome}` : '(loja não informada)';
  },
  rotuloCurto(c) {
    const cc = c.loja_id && RH.get('centros', c.loja_id); if (cc) return cc.nome.replace(/\s+-\s+/, ' · ');
    const l = c.loja_ref && Repo.get('lojas', c.loja_ref); return l ? `${l.codigo} · ${l.nome}` : this.rotuloLoja(c);
  },
  /** Quem é a outra parte (locador, seguradora ou fornecedor). */
  contraparte(c) { const t = this.tipo(c); return t === 'seguro' ? c.seguradora : t === 'outro' ? c.contraparte : c.locador; },
  ativoDoCentro(centroId, ignorarId = null) { return this.ativos().find(c => c.loja_id === centroId && c.id !== ignorarId) || null; },
  ativoDaLojaRef(lojaId, ignorarId = null) { return this.ativos().find(c => c.loja_ref === lojaId && c.id !== ignorarId) || null; },
  daLoja(l) {
    if (!l) return null;
    const cc = this.centroDaLoja(l);
    return (cc && this.ativoDoCentro(cc.id)) || this.ativoDaLojaRef(l.id) || null;
  },
  /** Contrato que ainda está só no cadastro da loja (versões anteriores), com vencimento válido. */
  legadoDaLoja(l) {
    const k = l?.contrato; if (!k || !this.dataValida(k.fim) || this.daLoja(l)) return null;
    return { id: 'legado-' + l.id, tipo: 'locacao', _legado: true, loja_ref: l.id, status: l.ativa ? 'Ativo' : 'Inativo',
      locador: k.locador || '', data_inicio: this.dataValida(k.inicio) ? k.inicio : '', data_vencimento: k.fim, indice_reajuste: k.indice || '',
      valor_atual: Number(k.valorAluguel) || 0, percentual_faturamento: Number(k.aluguelPercentual) || null,
      condominio: k.condominio, fundo_promocao: k.fundoPromocao, garantia: k.garantia, data_base_reajuste: k.dataBaseReajuste, observacoes: k.observacoes || '' };
  },
  /** Memorizado por Repo.rev (sobe a cada gravação ou snapshot): não recalcula a cada desenho da tela. */
  _leg: { chave: null, lista: [] },
  legados() {
    if (!Repo.prontas.has('lojas')) return [];
    const k = Repo.rev;
    if (this._leg.chave === k) return this._leg.lista;
    this._leg = { chave: k, lista: Repo.todos('lojas').map(l => this.legadoDaLoja(l)).filter(Boolean) };
    return this._leg.lista;
  },
  /** Matriz global: tabela de contratos + contratos ainda guardados só no cadastro das lojas. */
  matriz({ inativos = true } = {}) { return [...this.global({ inativos }), ...this.legados().filter(c => inativos || c.status !== 'Inativo')]; },
  /** Alimenta o radar: locação, ativa, com data_vencimento válida (inclui os legados das lojas). */
  paraRadar() { return this.matriz({ inativos: false }).filter(c => this.tipo(c) === 'locacao' && this.dataValida(c.data_vencimento)); },
  /** Situação da vigência (apólices e outros contratos). */
  vigencia(c, hoje = Datas.hoje()) {
    if (!this.dataValida(c.data_vencimento)) return { cls: 'neutral', txt: 'sem vencimento' };
    const d = Datas.dias(hoje, Datas.de(c.data_vencimento));
    return d < 0 ? { cls: 'bad', txt: `vencido há ${-d} dia${d === -1 ? '' : 's'}`, d } : d <= 60 ? { cls: 'warn', txt: `vence em ${d} dia${d === 1 ? '' : 's'}`, d } : { cls: 'ok', txt: `vigente · ${Datas.mesesEntre(hoje, Datas.de(c.data_vencimento))} meses`, d };
  },

  validar(d, id = null) {
    const e = [], t = this.tipo(d);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.data_inicio || '')) e.push('data de início inválida');
    if (d.data_vencimento && !/^\d{4}-\d{2}-\d{2}$/.test(d.data_vencimento)) e.push('data de vencimento inválida');
    else if (d.data_inicio && d.data_vencimento && d.data_vencimento <= d.data_inicio) e.push('o vencimento deve ser posterior ao início');
    if (!CT_STATUS.includes(d.status)) e.push('situação inválida');
    if (t === 'locacao') {
      if (!d.loja_id && !d.loja_ref) e.push('escolha a loja (centro de custo)');
      if (!String(d.locador || '').trim()) e.push('informe o locador');
      if (!d.data_vencimento) e.push('informe o vencimento');
      if (!String(d.indice_reajuste || '').trim()) e.push('informe o índice de reajuste');
      if (!(Number(d.valor_atual) > 0)) e.push('informe o valor atual do aluguel');
      if (d.percentual_faturamento != null && d.percentual_faturamento !== '' && !(Number(d.percentual_faturamento) >= 0 && Number(d.percentual_faturamento) <= 100)) e.push('o percentual sobre vendas deve estar entre 0 e 100');
      if (!e.length && d.status === 'Ativo') {
        const outro = (d.loja_id && this.ativoDoCentro(d.loja_id, id)) || (d.loja_ref && this.ativoDaLojaRef(d.loja_ref, id));
        if (outro) e.push(`já existe contrato ativo para ${this.rotuloLoja(outro)} (vence ${Fmt.data(outro.data_vencimento)}): inative-o antes, se este for a renovação`);
      }
    } else if (t === 'seguro') {
      if (!String(d.seguradora || '').trim()) e.push('informe a seguradora');
      if (!d.data_vencimento) e.push('informe o fim da vigência');
      if (!(d.lojas_ids || []).length) e.push('associe a apólice a pelo menos uma filial');
    } else {
      if (!String(d.contraparte || '').trim()) e.push('informe a outra parte do contrato');
      if (!String(d.objeto || '').trim()) e.push('descreva o objeto do contrato');
    }
    return e;
  },
  async salvar(id, dados, detalhe = '') {
    const rid = id || 'ct-' + uid(), antes = this.get(id) || { criadoEm: new Date().toISOString(), criadoPor: Auth.id };
    const t = this.tipo(dados), n2 = v => v === '' || v == null || isNaN(Number(v)) ? null : Math.round(Number(v) * 100) / 100;
    const doc = { ...antes, ...dados, tipo: t };
    if (t === 'locacao') {
      doc.valor_atual = n2(dados.valor_atual) ?? 0;
      doc.percentual_faturamento = dados.percentual_faturamento === '' || dados.percentual_faturamento == null ? null : Math.round(Number(dados.percentual_faturamento) * 10000) / 10000;
      ['condominio', 'fundo_promocao'].forEach(k => { if (k in doc) doc[k] = n2(doc[k]); });
    } else if (t === 'outro') doc.valor_atual = n2(dados.valor_atual);
    delete doc.id; delete doc._legado;
    await Repo.salvar(this.COL, rid, doc, { modulo: 'lojas', rotulo: `${CT_TIPOS[t]} · ${t === 'seguro' ? `${doc.seguradora} ${doc.numero_apolice || ''}`.trim() : this.rotuloLoja(doc)}`, detalhe });
    if (t === 'locacao') MotorAluguel.agendar('contrato alterado'); // atualiza a provisão de aluguel no FCX
    if (t === 'seguro') await SegurosVigencia.gravar(rid, doc); // espelho sem valores para o perfil OPERACIONAL
    return rid;
  },
  async alterarStatus(id, status) {
    const c = this.get(id); const { id: _, ...x } = c;
    await Repo.salvar(this.COL, id, { ...x, status, ...(status === 'Inativo' ? { inativadoEm: new Date().toISOString(), inativadoPor: Auth.id } : { inativadoEm: null, inativadoPor: null }) },
      { modulo: 'lojas', rotulo: `${CT_TIPOS[this.tipo(c)]} · ${this.rotuloLoja(c)}`, detalhe: status === 'Inativo' ? 'Inativado' : 'Reativado' });
    if (this.tipo(c) === 'locacao') MotorAluguel.agendar('contrato ' + (status === 'Inativo' ? 'inativado' : 'reativado'));
    if (this.tipo(c) === 'seguro') await SegurosVigencia.gravar(id, { ...c, status });
  },
};

/* ============================ 6. SERVIÇOS ============================ */
/**
 * Radar de ações renovatórias. Lei 8.245/91, art. 51 §5º: a ação renovatória deve ser proposta
 * no intervalo de 1 ano até 6 meses antes do fim do contrato (prazo decadencial).
 *   Zona Verde    — mais de 12 meses para o vencimento (seguro)
 *   Zona Amarela  — entre 12 e 6 meses: janela da renovatória ABERTA (alerta)
 *   Zona Vermelha — menos de 6 meses (ou vencido): prazo legal perdido, depende de negociação
 * Fonte: ContratosLocacao.paraRadar() — matriz global (tabela + cadastros das lojas), só locação, vencimento válido.
 */
const RadarRenovatoria = {
  ZONAS: {
    verde: { rotulo: 'Zona Verde', desc: 'Seguro · mais de 12 meses', cls: 'ok' },
    amarela: { rotulo: 'Zona Amarela', desc: 'Ação renovatória · entre 12 e 6 meses', cls: 'warn' },
    vermelha: { rotulo: 'Zona Vermelha', desc: 'Risco crítico · menos de 6 meses', cls: 'bad' },
  },
  classificar(c, hoje = Datas.hoje()) {
    const venc = ContratosLocacao.dataValida(c.data_vencimento) ? Datas.de(c.data_vencimento) : null, ini = ContratosLocacao.dataValida(c.data_inicio) ? Datas.de(c.data_inicio) : null;
    if (!venc) return { zona: null };
    const zona = venc > Datas.addMeses(hoje, 12) ? 'verde' : venc >= Datas.addMeses(hoje, 6) ? 'amarela' : 'vermelha';
    const janela = { de: Datas.addMeses(venc, -12), ate: Datas.addMeses(venc, -6) };
    const dias = Datas.dias(hoje, venc), meses = Datas.mesesEntre(hoje, venc);
    return {
      zona, venc, ini, janela, dias, meses, vencido: dias < 0,
      diasParaAbrir: zona === 'verde' ? Datas.dias(hoje, janela.de) : null,     // verde: quando a janela abre
      diasParaFechar: zona === 'amarela' ? Datas.dias(hoje, janela.ate) : null, // amarela: quanto falta para perder o prazo
      requisito5anos: ini ? Datas.addMeses(ini, 60) <= new Date(+venc + 864e5) : null, // art. 51, II (soma dos prazos ininterruptos ≥ 5 anos)
    };
  },
  prazoTexto(r) {
    if (!r.zona) return 'sem vencimento';
    if (r.vencido) return `vencido há ${-r.dias} dia${r.dias === -1 ? '' : 's'}`;
    if (r.meses >= 1) return `vence em ${r.meses} ${r.meses === 1 ? 'mês' : 'meses'}`;
    return `vence em ${r.dias} dia${r.dias === 1 ? '' : 's'}`;
  },
  /** Painel: contratos de locação da matriz global classificados e ordenados por urgência. */
  painel(lista = ContratosLocacao.paraRadar(), hoje = Datas.hoje()) {
    const ordem = { amarela: 0, vermelha: 1, verde: 2 };
    const itens = lista.filter(c => ContratosLocacao.tipo(c) === 'locacao' && c.status !== 'Inativo').map(c => ({ c, r: this.classificar(c, hoje) })).filter(x => x.r.zona)
      .sort((a, b) => ordem[a.r.zona] - ordem[b.r.zona] || a.r.venc - b.r.venc);
    const cont = { verde: 0, amarela: 0, vermelha: 0 }, valor = { verde: 0, amarela: 0, vermelha: 0 };
    itens.forEach(x => { cont[x.r.zona]++; valor[x.r.zona] += Number(x.c.valor_atual) || 0; });
    return { itens, cont, valor, hoje, vencidos: itens.filter(x => x.r.vencido).length, legados: itens.filter(x => x.c._legado).length };
  },
};

/** Leitor de documentos: PDF → texto (Util) → IA → dados normalizados para o formulário. */
const LeitorContratoIA = {
  CAMPOS: ['locador', 'data_inicio', 'data_vencimento', 'indice_reajuste', 'valor_atual', 'percentual_faturamento'],
  get disponivel() { return IA.disponivel; },
  pdf(file) { if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') throw new Error('Envie o documento em PDF.'); },
  async ler(file, onStatus = () => { }) {
    this.pdf(file);
    const r = await IA.executar(CONTRATO_PROMPT, file, onStatus);
    const dados = this.normalizar(r.json || {});
    return { dados, bruto: r.json, paginas: r.paginas, digitalizado: r.digitalizado, centroSugerido: this.sugerirCentro(r.json?.imovel || '', r.texto?.slice(0, 6000) || '') };
  },
  /** Apólice: coberturas, prêmios e condições de pagamento + filiais sugeridas pelos locais de risco. */
  async lerApolice(file, onStatus = () => { }) {
    this.pdf(file);
    const r = await IA.executar(APOLICE_PROMPT, file, onStatus);
    const dados = this.normalizarApolice(r.json || {});
    return { dados, bruto: r.json, paginas: r.paginas, digitalizado: r.digitalizado, lojasSugeridas: this.sugerirLojas(dados.locais.join(' | '), r.texto?.slice(0, 12000) || '') };
  },
  data(v) {
    if (!v) return '';
    const s = String(v).trim(); let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
  },
  valor(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).replace(/[^\d,.-]/g, ''); if (!s) return null;
    const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
    return isFinite(n) ? n : null;
  },
  indice(v) {
    const k = RH.chave(v || '').replace(/[^A-Z]/g, '');
    if (!k) return '';
    if (k.startsWith('IGPM') || k.startsWith('IGP')) return 'IGP-M';
    if (k.startsWith('IPCA')) return 'IPCA';
    if (k.startsWith('INPC')) return 'INPC';
    if (k.startsWith('IVAR')) return 'IVAR';
    if (k.startsWith('FIXO') || k.startsWith('SEM')) return 'Fixo (sem índice)';
    return String(v).trim();
  },
  normalizar(j) {
    const d = {
      locador: String(j.locador || '').trim(),
      data_inicio: this.data(j.data_inicio),
      data_vencimento: this.data(j.data_vencimento),
      indice_reajuste: this.indice(j.indice_reajuste),
      valor_atual: this.valor(j.valor_atual),
      percentual_faturamento: this.valor(j.percentual_faturamento),
    };
    // só o prazo? calcula o vencimento (último dia do prazo)
    if (!d.data_vencimento && d.data_inicio && Number(j.prazo_meses) > 0) d.data_vencimento = Datas.iso(new Date(Datas.addMeses(Datas.de(d.data_inicio), Number(j.prazo_meses)) - 864e5));
    return { ...d, confianca: j.confianca || {}, evidencias: j.evidencias || {}, observacoes: String(j.observacoes || '').trim(), imovel: String(j.imovel || '').trim() };
  },
  normalizarApolice(j) {
    const p = j.premios || {}, cp = j.condicoes_pagamento || {}, txt = v => String(v ?? '').trim();
    const ramo = CT_RAMOS.find(r => RH.chave(txt(j.ramo)).includes(RH.chave(r.split(' ')[0]))) || (txt(j.ramo) ? 'Outro' : '');
    return {
      seguradora: txt(j.seguradora), numero_apolice: txt(j.numero_apolice), ramo, segurado: txt(j.segurado), corretora: txt(j.corretora),
      data_inicio: this.data(j.data_inicio), data_vencimento: this.data(j.data_vencimento),
      coberturas: (Array.isArray(j.coberturas) ? j.coberturas : []).filter(x => x && txt(x.nome)).map(x => ({ nome: txt(x.nome), limite: this.valor(x.limite), franquia: txt(x.franquia) === 'null' ? '' : txt(x.franquia) })),
      premios: { liquido: this.valor(p.liquido), adicional: this.valor(p.adicional_fracionamento), iof: this.valor(p.iof), total: this.valor(p.total) },
      pagamento: { forma: txt(cp.forma), parcelas: this.valor(cp.parcelas), valor_parcela: this.valor(cp.valor_parcela), primeiro_vencimento: this.data(cp.primeiro_vencimento),
        vencimentos: (Array.isArray(cp.vencimentos) ? cp.vencimentos : []).map(v => this.data(v)).filter(Boolean), observacao: txt(cp.observacao) === 'null' ? '' : txt(cp.observacao) },
      locais: (Array.isArray(j.locais_segurados) ? j.locais_segurados : []).map(txt).filter(Boolean),
      carencias: (Array.isArray(j.carencias) ? j.carencias : []).filter(x => x && (txt(x.cobertura) || txt(x.prazo))).map(x => [txt(x.cobertura), txt(x.prazo), txt(x.detalhe)].filter(v => v && v !== 'null').join(' — ')).join('\n'),
      confianca: j.confianca || {}, evidencias: j.evidencias || {}, observacoes: txt(j.observacoes),
    };
  },
  /** Palavras que identificam a loja: nome (sem termos genéricos) e logradouro do endereço. */
  palavrasLoja(l) {
    const gen = ['SHOPPING', 'LOJA', 'CENTRO', 'PLAZA', 'MALL', 'ESPOSENDE', 'SPORTS', 'AVENIDA', 'RUA', 'PRACA', 'BAIRRO'];
    const lim = s => RH.chave(s || '').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(p => p.length > 3 && !gen.includes(p));
    return { nome: lim(l.nome), end: lim(String(l.endereco || '').split(/[,\-–]/)[0]).slice(0, 4) };
  },
  /** Filiais citadas nos locais de risco da apólice (nome da loja ou logradouro). */
  sugerirLojas(locais, texto = '') {
    const alvo = ' ' + RH.chave(locais || texto).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const lojas = Repo.todos('lojas').filter(l => l.ativa);
    // nome de cidade com 2+ lojas não identifica a loja ("RECIFE" casaria com todas as lojas de Recife);
    // cidade com uma loja só (ex.: CAMARAGIBE) ainda identifica. Números (nº do imóvel) também ficam de fora.
    const porCidade = new Map(); lojas.forEach(l => new Set(RH.chave(l.cidade || '').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)).forEach(w => porCidade.set(w, (porCidade.get(w) || 0) + 1)));
    const ambigua = w => (porCidade.get(w) || 0) >= 2 || /^\d+$/.test(w);
    return lojas.map(l => {
      const p = this.palavrasLoja(l), achou = ws => [...new Set(ws)].filter(w => !ambigua(w) && alvo.includes(' ' + w + ' '));
      // nome da loja vale sozinho; o logradouro só conta com 2+ palavras (um sobrenome como "CORREIA" não basta)
      const nome = achou(p.nome), rua = achou(p.end).filter(w => !nome.includes(w)), pts = [...nome, ...(rua.length >= 2 ? rua : [])].reduce((a, w) => a + w.length, 0);
      return { l, pts };
    }).filter(x => x.pts >= 6).sort((a, b) => b.pts - a.pts).map(x => x.l.id);
  },
  /**
   * Sugere o centro de custo da loja pelo nome que aparece no imóvel (ex.: "TACARUNA").
   * Pontua pelas palavras do nome da loja encontradas (as mais longas pesam mais: "TACARUNA" > "RECIFE");
   * procura primeiro na identificação do imóvel e, se nada casar, no começo do contrato.
   */
  sugerirCentro(imovel, texto = '') {
    const centros = ContratosLocacao.centrosDeLoja().filter(c => c.status !== 'inativo');
    const busca = alvo => {
      const t = ' ' + RH.chave(alvo).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
      let pontos = 0, cands = [];
      for (const cc of centros) {
        const pal = RH.chave(cc.nome.replace(/^\d{3}\s*-\s*/, '')).replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(p => p.length > 3 && !['SHOPPING', 'LOJA', 'CENTRO', 'PLAZA', 'MALL'].includes(p));
        const pts = pal.filter(p => t.includes(' ' + p + ' ')).reduce((a, p) => a + p.length, 0);
        if (pts > pontos) { pontos = pts; cands = [cc]; } else if (pts && pts === pontos) cands.push(cc);
      }
      return cands.length ? { centro: cands.length === 1 ? cands[0] : null, candidatos: cands } : null;
    };
    return (imovel && busca(imovel)) || (texto && busca(texto)) || { centro: null, candidatos: [] };
  },
};

/**
 * Radar de seguros (alerta de vigência): Verde vigente · Amarela 30 dias ou menos para vencer · Vermelha expirada.
 * Fonte: apólices ativas da tabela global (GESTOR) ou o espelho seguros_vigencia (OPERACIONAL, sem valores).
 */
const RadarSeguros = {
  JANELA: 30,
  ZONAS: {
    verde: { rotulo: 'Vigente', desc: 'mais de 30 dias para vencer', cls: 'ok' },
    amarela: { rotulo: 'Vence em até 30 dias', desc: 'renovar a apólice', cls: 'warn' },
    vermelha: { rotulo: 'Expirada', desc: 'sem cobertura: renovar já', cls: 'bad' },
  },
  classificar(c, hoje = Datas.hoje()) {
    if (!ContratosLocacao.dataValida(c.data_vencimento)) return { zona: null, txt: 'sem vencimento' };
    const d = Datas.dias(hoje, Datas.de(c.data_vencimento));
    const zona = d < 0 ? 'vermelha' : d <= this.JANELA ? 'amarela' : 'verde';
    const txt = d < 0 ? `expirou há ${-d} dia${d === -1 ? '' : 's'}` : d === 0 ? 'vence hoje' : d <= this.JANELA ? `vence em ${d} dia${d === 1 ? '' : 's'}` : `vigente · vence ${Fmt.data(c.data_vencimento)}`;
    return { zona, d, txt };
  },
  pill(c) { const r = this.classificar(c), z = this.ZONAS[r.zona]; return z ? `<span class="pill ${z.cls}" title="${esc(z.desc)}">${r.zona === 'verde' ? '' : r.zona === 'amarela' ? ICON.alerta + ' ' : ICON.alerta + ' '}${esc(r.txt)}</span>` : '<span class="pill neutral">sem vencimento</span>'; },
  /** Lista: apólices completas (GESTOR) ou espelho sem valores (OPERACIONAL). */
  fonte() { return Contratos.pode() ? ContratosLocacao.seguros({ inativos: false }) : SegurosVigencia.todos(); },
  daLoja(lojaId) { return this.fonte().filter(c => (c.lojas_ids || []).includes(lojaId)).sort((a, b) => (a.data_vencimento || '').localeCompare(b.data_vencimento || '')); },
  painel(lista = this.fonte()) {
    const cont = { verde: 0, amarela: 0, vermelha: 0 }, itens = lista.map(c => ({ c, r: this.classificar(c) })).filter(x => x.r.zona);
    itens.forEach(x => cont[x.r.zona]++);
    itens.sort((a, b) => ({ vermelha: 0, amarela: 1, verde: 2 }[a.r.zona] - { vermelha: 0, amarela: 1, verde: 2 }[b.r.zona]) || a.r.d - b.r.d);
    return { itens, cont, semVenc: lista.length - itens.length };
  },
};

/**
 * Espelho público das apólices (seguros_vigencia/<id do contrato>): só existência e validade, SEM prêmios
 * ou coberturas. Regra do banco: leitura OPERACIONAL (interact), escrita GESTOR (admin).
 */
const SegurosVigencia = {
  COL: 'seguros_vigencia',
  todos() { return Repo.todos(this.COL).filter(s => s.status !== 'Inativo'); },
  resumo(c) { return { seguradora: c.seguradora || '', ramo: c.ramo || '', numero_apolice: c.numero_apolice || '', data_inicio: c.data_inicio || '', data_vencimento: c.data_vencimento || '', lojas_ids: c.lojas_ids || [], status: c.status || 'Ativo' }; },
  async gravar(id, c) {
    if (!Auth.can('lojas.contratos.editar') || !Repo.prontas.has(this.COL)) return;
    const novo = this.resumo(c), atual = Repo.get(this.COL, id);
    if (atual && JSON.stringify(this.resumo(atual)) === JSON.stringify(novo)) return;
    await Repo.salvar(this.COL, id, novo, { modulo: 'lojas', semAudit: true });
  },
  /** Confere o espelho inteiro contra a tabela global (GESTOR, uma vez por sessão). */
  async sincronizarTudo() {
    const segs = ContratosLocacao.seguros(), ids = new Set(segs.map(s => s.id));
    for (const s of segs) await this.gravar(s.id, s);
    for (const m of Repo.todos(this.COL)) if (!ids.has(m.id)) await Repo.excluir(this.COL, m.id, { modulo: 'lojas', semAudit: true });
  },
};

/** Manutenção que roda uma vez por sessão do GESTOR: migra as apólices antigas e confere o espelho. */
const ContratosManutencao = {
  _feito: false,
  iniciar() {
    if (this._feito || !Auth.can('lojas.contratos.editar')) return;
    const pronto = () => ['lojas', ContratosLocacao.COL, SegurosVigencia.COL].every(c => Repo.prontas.has(c));
    let t = 0; const chk = () => { if (pronto()) return this.rodar(); if (++t < 120) setTimeout(chk, 500); }; chk();
  },
  async rodar() {
    if (this._feito) return; this._feito = true;
    try { const n = await this.migrarSeguros(); if (n) UI.toast(`${n} apólice(s) do cadastro das lojas migrada(s) para o Módulo 3.`); await SegurosVigencia.sincronizarTudo(); }
    catch (e) { console.warn('Manutenção de contratos:', e); this._feito = false; }
  },
  /** Repositório único: lojas.seguros[] → tabela global (id determinístico, não duplica se rodar de novo). */
  async migrarSeguros() {
    let n = 0;
    for (const l of Repo.todos('lojas')) {
      const segs = l.seguros || []; if (!segs.length) continue;
      for (const s of segs) {
        const id = `ct-seg-${l.id}-${String(s.id || uid()).replace(/[^\w-]/g, '')}`;
        if (!ContratosLocacao.get(id)) {
          const r = s.resumoIA || {};
          const doc = { tipo: 'seguro', status: 'Ativo', seguradora: s.seguradora || r.seguradora || '', numero_apolice: s.apolice || r.numeroApolice || '', ramo: s.tipo || '', corretora: s.corretora || '',
            data_inicio: s.inicio || r.vigencia?.inicio || '', data_vencimento: s.vencimento || r.vigencia?.fim || '', lojas_ids: [l.id],
            coberturas: (r.coberturas || []).map(x => ({ nome: x.nome || '', limite: x.limite ?? null, franquia: x.franquia || '' })),
            premios: { liquido: null, adicional: null, iof: null, total: Number(s.premio) || r.premioTotal || null }, importancia_segurada: Number(s.importancia) || null,
            pagamento: { forma: s.pagamento || '', parcelas: null, valor_parcela: null, primeiro_vencimento: '', vencimentos: [], observacao: '' },
            arquivo: s.arquivo || null, resumoIA: s.resumoIA || null, observacoes: '', migradoDe: { loja: l.id, seguro: s.id || null, em: new Date().toISOString() } };
          await ContratosLocacao.salvar(id, doc, 'Apólice migrada do cadastro da loja');
          n++;
        }
      }
      const atual = Repo.get('lojas', l.id); const { id: _, ...x } = atual;
      await Repo.salvar('lojas', l.id, { ...x, seguros: [], segurosMigrados: (atual.segurosMigrados || 0) + segs.length }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · seguros`, detalhe: `${segs.length} apólice(s) movida(s) para o Módulo 3` });
    }
    return n;
  },
};

/* ============================ 7. UI — Módulo 3 ============================ */
const Contratos = {
  ui: { aba: 'lista', busca: '', tipo: '', zona: '', status: 'Ativo', pagina: 1, radarTodos: false },
  _lista: [], _radar: null, _fcxTimer: null, _fcxV: -1,
  pode() { return Auth.can('lojas.contratos.ver'); },
  podeEd() { return Auth.can('lojas.contratos.editar'); },
  pillZona(r) { const z = RadarRenovatoria.ZONAS[r.zona]; return z ? `<span class="pill ${z.cls}">${z.rotulo}</span>` : '<span class="pill neutral">—</span>'; },
  /** Pílula para a lista de lojas do Módulo 2 (coluna "Contrato"), quando há contrato de locação na matriz global. */
  pillDaLoja(l) {
    if (!this.pode() || !Repo.prontas.has(ContratosLocacao.COL)) return null;
    const c = ContratosLocacao.daLoja(l) || ContratosLocacao.legadoDaLoja(l); if (!c) return null;
    const r = RadarRenovatoria.classificar(c); const z = RadarRenovatoria.ZONAS[r.zona]; if (!z) return null;
    return `<span class="pill ${z.cls}" title="${esc(z.desc)}">${esc(RadarRenovatoria.prazoTexto(r))}</span>`;
  },
  pronto() { return [ContratosLocacao.COL, 'rh_centros', 'lojas'].every(c => Repo.prontas.has(c)); },

  /* ---------------- tela do módulo ---------------- */
  render() {
    if (!this.pode()) return `<div class="page-head"><div><h1>Contratos de Locação e Outros</h1></div></div><div class="panel"><div class="empty">Contratos e apólices são restritos ao perfil GESTOR.</div></div>`;
    const u = this.ui, n = this.pronto() ? ContratosLocacao.matriz().filter(c => c.status !== 'Inativo').length : 0;
    const head = `<div class="page-head"><div><h1>Contratos de Locação e Outros</h1><p>Repositório central: contratos de locação (inclusive os criados no cadastro das lojas), apólices de seguro e demais contratos, com radar de ações renovatórias e de vigência dos seguros.</p></div>
      ${this.podeEd() ? `<div class="row"><button class="btn sec" data-a="ct-novo" data-t="seguro">+ Nova apólice</button><button class="btn" data-a="ct-novo">+ Novo contrato</button></div>` : ''}</div>`;
    if (!this.pronto()) return head + '<div class="panel"><p class="muted" style="margin:0">Carregando contratos…</p></div>';
    const abas = `<div class="tabs" role="tablist">${[['lista', `Contratos e apólices (${n})`], ['ocupacao', 'Projeção de custos de ocupação']].map(([k, r]) => `<button class="${u.aba === k ? 'on' : ''}" role="tab" aria-selected="${u.aba === k}" data-a="ct-aba" data-v="${k}">${r}</button>`).join('')}</div>`;
    return head + `<div class="grid ct-radares">${this.renderRadar()}${this.renderRadarSeguros()}</div>` + abas + (u.aba === 'ocupacao' ? ProjecaoOcupacao.render() : this.renderLista());
  },
  afterRender() {
    if (!this.pode()) return;
    this.montarRadar(); this.montarLista();
    if (this.ui.aba === 'ocupacao') { ProjecaoOcupacao.afterRender(); this.vigiarFCX(); } else this.pararVigia();
  },
  /**
   * O FCX só redesenha a projeção quando ela está no Módulo 2 (fcx.js não é alterado). Aqui no Módulo 3 um vigia
   * leve observa FCX.versao enquanto a aba está aberta e redesenha quando o FCX carrega ou muda; para sozinho ao sair.
   */
  vigiarFCX() {
    if (this._fcxTimer) return;
    this._fcxV = FCX.versao;
    this._fcxTimer = setInterval(() => {
      if (App.rota !== 'contratos' || this.ui.aba !== 'ocupacao') return this.pararVigia();
      if (FCX.versao !== this._fcxV) { this._fcxV = FCX.versao; App.agendarRender(); }
    }, 700);
  },
  pararVigia() { if (this._fcxTimer) { clearInterval(this._fcxTimer); this._fcxTimer = null; } },

  /* ---------------- Radar de ações renovatórias (topo do Módulo 3) ---------------- */
  renderRadar() {
    const p = RadarRenovatoria.painel(); this._radar = p;
    const Z = RadarRenovatoria.ZONAS, amarelas = p.itens.filter(x => x.r.zona === 'amarela');
    const criticas = p.itens.filter(x => x.r.zona === 'vermelha' && !x.r.vencido);
    const alerta = amarelas.length ? `<div class="alerta-renov" role="alert"><div class="ic">${ICON.alerta}</div><div style="flex:1;min-width:0">
        <b>${amarelas.length} contrato${amarelas.length > 1 ? 's' : ''} na janela da ação renovatória</b>
        <div class="hint" style="color:inherit;opacity:.9">Lei 8.245/91, art. 51 §5º: a ação deve ser proposta até 6 meses antes do vencimento. Depois disso o direito decai.</div>
        <ul class="renov-lista">${amarelas.map(x => `<li><span><b>${esc(ContratosLocacao.rotuloCurto(x.c))}</b> — ajuizar até <b>${Fmt.data(Datas.iso(x.r.janela.ate))}</b></span> <span class="pill warn">${x.r.diasParaFechar} dia${x.r.diasParaFechar === 1 ? '' : 's'}</span>${x.r.requisito5anos === false ? ' <span class="pill neutral" title="Art. 51, II: prazo mínimo de 5 anos (contratos escritos, ininterruptos)">conferir requisito de 5 anos</span>' : ''}</li>`).join('')}</ul></div></div>` : '';
    const kpis = `<div class="grid g4 ct-kpis" style="margin-bottom:14px">
      <div class="kpi zona-kpi ok"><div class="k">${Z.verde.rotulo}</div><div class="v">${p.cont.verde}</div><div class="d">${Z.verde.desc}</div></div>
      <div class="kpi zona-kpi warn"><div class="k">${Z.amarela.rotulo}</div><div class="v" style="color:var(${p.cont.amarela ? '--warn' : '--ink'})">${p.cont.amarela}</div><div class="d">janela da renovatória aberta</div></div>
      <div class="kpi zona-kpi bad"><div class="k">${Z.vermelha.rotulo}</div><div class="v" style="color:var(${p.cont.vermelha ? '--bad' : '--ink'})">${p.cont.vermelha}</div><div class="d">${criticas.length} a vencer · ${p.vencidos} vencido${p.vencidos === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="k">Aluguel mensal em risco</div><div class="v mono">${Fmt.brl0(p.valor.amarela + p.valor.vermelha)}</div><div class="d">zonas amarela e vermelha · ${Fmt.brl0(p.valor.verde + p.valor.amarela + p.valor.vermelha)} no total</div></div></div>`;
    const leg = p.legados ? `<div class="note" style="margin-bottom:12px">${p.legados} contrato(s) do radar ainda estão só no cadastro da loja (versões anteriores). Use “Migrar” na lista para levá-los à tabela global.</div>` : '';
    const vazio = !p.itens.length ? `<div class="empty">Nenhum contrato de locação ativo com vencimento. ${this.podeEd() ? 'Use “+ Novo contrato”: o leitor com IA preenche os dados a partir do PDF.' : ''}</div>` : '';
    return `<section class="panel radar" aria-labelledby="radarTit">
      <div style="margin-bottom:12px"><h2 id="radarTit">Radar de ações renovatórias</h2><p class="sub" style="margin-bottom:0">Contratos de locação da matriz global (tabela de contratos + cadastros das lojas). Janela legal: de 12 a 6 meses antes do vencimento.</p></div>
      ${kpis}${leg}${alerta}
      ${vazio || `<div class="rd" id="radarTimeline" aria-label="Linha do tempo dos contratos"></div>
        <div class="row between" style="margin-top:10px"><div class="rd-leg"><span><i class="sw verde"></i>vigência segura</span><span><i class="sw amarela"></i>janela da renovatória</span><span><i class="sw vermelha"></i>últimos 6 meses</span><span><i class="sw hoje"></i>hoje</span></div>
          ${p.itens.length > RADAR_LINHAS ? `<button class="btn ghost sm" data-a="ct-radar-todos">${this.ui.radarTodos ? 'Mostrar só os mais urgentes' : `Ver todos (${p.itens.length})`}</button>` : ''}</div>`}
    </section>`;
  },
  /** Linha do tempo montada com DocumentFragment (fora do innerHTML principal). */
  montarRadar() {
    const alvo = $('#radarTimeline'), p = this._radar; if (!alvo || !p) return;
    const hoje = p.hoje, ini = new Date(hoje.getFullYear(), hoje.getMonth() - 3, 1), fim = new Date(hoje.getFullYear(), hoje.getMonth() + 27, 1);
    const pos = d => Math.max(0, Math.min(100, (d - ini) / (fim - ini) * 100));
    const seg = (cls, a, b) => { const x = pos(a), y = pos(b); return y > x ? `<i class="rd-seg ${cls}" style="left:${x.toFixed(2)}%;width:${(y - x).toFixed(2)}%"></i>` : ''; };
    const meses = []; for (let d = new Date(ini); d <= fim; d = Datas.addMeses(d, 3)) meses.push(d);
    const lista = this.ui.radarTodos ? p.itens : p.itens.slice(0, RADAR_LINHAS);
    const tpl = document.createElement('template');
    tpl.innerHTML = `<div class="rd-row rd-eixo" aria-hidden="true"><div class="rd-lbl"></div><div class="rd-track">${meses.map(d => `<span style="left:${pos(d).toFixed(2)}%">${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][d.getMonth()]}/${String(d.getFullYear()).slice(2)}</span>`).join('')}</div><div></div></div>`
      + lista.map(({ c, r }) => {
        const inicio = r.ini && r.ini > ini ? r.ini : ini, alemEixo = r.venc > fim;
        const quando = r.zona === 'amarela' ? `ajuizar até ${Fmt.data(Datas.iso(r.janela.ate))}` : r.zona === 'verde' ? `janela abre em ${Fmt.data(Datas.iso(r.janela.de))}` : r.vencido ? 'prazo legal perdido · vencido' : 'prazo legal perdido · negociar';
        const acao = c._legado ? `data-a="ct-migrar" data-l="${esc(c.loja_ref)}"` : `data-a="ct-editar" data-id="${c.id}"`;
        return `<div class="rd-row z-${r.zona}" ${acao} role="button" tabindex="0" title="${esc(RadarRenovatoria.ZONAS[r.zona].desc)}">
          <div class="rd-lbl"><b>${esc(ContratosLocacao.rotuloCurto(c))}</b>${c._legado ? ' <span class="pill neutral">cadastro da loja</span>' : ''}<span class="cell-sub">vence ${Fmt.data(c.data_vencimento)} · ${esc(quando)}</span></div>
          <div class="rd-track">${seg('verde', inicio, r.janela.de)}${seg('amarela', r.janela.de, r.janela.ate)}${seg('vermelha', r.janela.ate, r.venc)}
            ${alemEixo ? `<span class="rd-alem">→ ${Fmt.data(c.data_vencimento)}</span>` : `<i class="rd-fim" style="left:${pos(r.venc).toFixed(2)}%"></i>`}<i class="rd-hoje" style="left:${pos(hoje).toFixed(2)}%"></i></div>
          <div class="rd-z">${this.pillZona(r)}<span class="cell-sub">${esc(RadarRenovatoria.prazoTexto(r))}</span></div></div>`;
      }).join('');
    const frag = document.createDocumentFragment(); frag.appendChild(tpl.content); alvo.replaceChildren(frag);
  },

  /* ---------------- Radar de seguros (alerta de vigência) ---------------- */
  renderRadarSeguros() {
    const p = RadarSeguros.painel(), Z = RadarSeguros.ZONAS, alertas = p.itens.filter(x => x.r.zona !== 'verde');
    const premio = ContratosLocacao.seguros({ inativos: false }).reduce((a, c) => a + (Number(c.premios?.total) || 0), 0);
    return `<section class="panel radar-seg" aria-labelledby="radarSegTit">
      <div style="margin-bottom:12px"><h2 id="radarSegTit">Radar de seguros</h2><p class="sub" style="margin-bottom:0">Alerta de vigência das apólices: amarelo a 30 dias do vencimento, vermelho quando expira.</p></div>
      <div class="grid g4 ct-kpis" style="margin-bottom:14px">
        <div class="kpi zona-kpi ok"><div class="k">${Z.verde.rotulo}</div><div class="v">${p.cont.verde}</div><div class="d">${Z.verde.desc}</div></div>
        <div class="kpi zona-kpi warn"><div class="k">${Z.amarela.rotulo}</div><div class="v" style="color:var(${p.cont.amarela ? '--warn' : '--ink'})">${p.cont.amarela}</div><div class="d">${Z.amarela.desc}</div></div>
        <div class="kpi zona-kpi bad"><div class="k">${Z.vermelha.rotulo}</div><div class="v" style="color:var(${p.cont.vermelha ? '--bad' : '--ink'})">${p.cont.vermelha}</div><div class="d">${Z.vermelha.desc}</div></div>
        <div class="kpi"><div class="k">Prêmios das apólices ativas</div><div class="v mono">${Fmt.brl0(premio)}</div><div class="d">${p.itens.length} apólice(s)${p.semVenc ? ` · ${p.semVenc} sem vencimento` : ''}</div></div></div>
      ${alertas.length ? `<ul class="seg-alertas" aria-label="Apólices em alerta">${alertas.slice(0, 8).map(({ c, r }) => `<li class="z-${r.zona}" data-a="ct-editar" data-id="${c.id}" role="button" tabindex="0">
          <span class="pill ${Z[r.zona].cls}">${ICON.alerta} ${esc(Z[r.zona].rotulo)}</span>
          <span class="seg-al-txt"><b>${esc(c.seguradora || 'Seguradora não informada')}</b> · ${esc(c.ramo || 'apólice')} ${c.numero_apolice ? `nº ${esc(c.numero_apolice)}` : ''}<span class="cell-sub">${esc(ContratosLocacao.rotuloLojas(c.lojas_ids || []))} · ${esc(r.txt)}</span></span></li>`).join('')}</ul>${alertas.length > 8 ? `<p class="hint">+ ${alertas.length - 8} apólice(s) em alerta na lista abaixo (filtro “Apólice de seguro”).</p>` : ''}`
        : p.itens.length ? '<div class="note ok-note">Todas as apólices estão vigentes por mais de 30 dias.</div>' : `<div class="empty">Nenhuma apólice cadastrada. ${this.podeEd() ? 'Use “+ Nova apólice”: o leitor com IA extrai coberturas, prêmios e pagamento do PDF.' : ''}</div>`}
    </section>`;
  },

  /* ---------------- Lista única (contratos + apólices) ---------------- */
  filtrados() {
    const u = this.ui, q = RH.chave(u.busca);
    return ContratosLocacao.matriz().map(c => ({ c, t: ContratosLocacao.tipo(c), r: ContratosLocacao.tipo(c) === 'locacao' ? RadarRenovatoria.classificar(c) : RadarSeguros.classificar(c) }))
      .filter(({ c, t, r }) => (!u.tipo || t === u.tipo) && (!u.status || c.status === u.status) && (!u.zona || (c.status === 'Ativo' && t === 'locacao' && r.zona === u.zona))
        && (!q || RH.chave([ContratosLocacao.rotuloLoja(c), ContratosLocacao.contraparte(c), c.indice_reajuste, c.numero_apolice, c.objeto, c.ramo, CT_TIPOS[t]].join(' ')).includes(q)))
      .sort((a, b) => (a.c.data_vencimento || '9999').localeCompare(b.c.data_vencimento || '9999'));
  },
  renderLista() {
    const u = this.ui; this._lista = this.filtrados();
    const sel = (k, rot, ops, todos = 'Todos') => `<div class="field"><label class="lbl" for="ct_${k}">${rot}</label><select id="ct_${k}" data-a="ct-filtro" data-k="${k}"><option value="">${todos}</option>${ops.map(([v, l]) => `<option value="${v}" ${v === u[k] ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    const m = ContratosLocacao.matriz(), por = t => m.filter(c => ContratosLocacao.tipo(c) === t && c.status !== 'Inativo').length;
    return `<div class="panel">
      <div class="row between" style="margin-bottom:6px"><div><h2>Contratos e apólices</h2><p class="sub">${por('locacao')} locação · ${por('seguro')} apólice(s) · ${por('outro')} outro(s) contrato(s) ativos. Inativar mantém o histórico (exclusão lógica).</p></div></div>
      <div class="toolbar">
        <div class="field grow"><label class="lbl" for="ctBusca">Buscar</label><input id="ctBusca" type="search" placeholder="Loja, locador, seguradora, nº da apólice…" value="${esc(u.busca)}" data-a="ct-busca"></div>
        ${sel('tipo', 'Tipo', Object.entries(CT_TIPOS), 'Todos os tipos')}${sel('zona', 'Radar renovatório', Object.entries(RadarRenovatoria.ZONAS).map(([k, z]) => [k, z.rotulo]), 'Todas as zonas')}${sel('status', 'Situação', CT_STATUS.map(s => [s, s + 's']), 'Todos')}</div>
      ${this._lista.length ? `<div class="tbl-wrap"><table id="ctTabela"><thead><tr><th>Tipo</th><th>Filial(is)</th><th>Contraparte</th><th>Início</th><th>Vencimento</th><th class="num">Valor</th><th>Radar / vigência</th><th>Situação</th>${this.podeEd() ? '<th></th>' : ''}</tr></thead><tbody id="ctBody"></tbody></table></div><div id="ctPager"></div>`
        : `<div class="empty">${m.length ? 'Nenhum contrato com esses filtros.' : 'Nenhum contrato cadastrado ainda.'}</div>`}
    </div>`;
  },
  linhaHTML({ c, t, r }) {
    const ed = this.podeEd(), inativo = c.status === 'Inativo';
    const tipo = `<span class="pill ${t === 'locacao' ? 'navy' : t === 'seguro' ? 'info' : 'neutral'}">${CT_TIPOS[t]}</span>${c._legado ? '<div class="cell-sub">cadastro da loja</div>' : ''}`;
    const valor = t === 'seguro' ? (c.premios?.total ? `<b>${Fmt.brl(c.premios.total)}</b><div class="cell-sub">prêmio total${c.pagamento?.parcelas ? ` · ${c.pagamento.parcelas}x` : ''}</div>` : '<span class="hint">—</span>')
      : c.valor_atual ? `<b>${Fmt.brl(c.valor_atual)}</b>${t === 'locacao' && Number(c.percentual_faturamento) > 0 ? `<div class="cell-sub">ou ${Fmt.pct(c.percentual_faturamento)} das vendas</div>` : '<div class="cell-sub">por mês</div>'}` : '<span class="hint">—</span>';
    const radar = inativo ? '<span class="hint">—</span>' : t === 'locacao' ? `${this.pillZona(r)}<div class="cell-sub">${esc(RadarRenovatoria.prazoTexto(r))}</div>` : t === 'seguro' ? RadarSeguros.pill(c) : `<span class="pill ${ContratosLocacao.vigencia(c).cls}">${esc(ContratosLocacao.vigencia(c).txt)}</span>`;
    const det = t === 'seguro' ? `${esc(c.ramo || 'Seguro')}${c.numero_apolice ? ` · nº ${esc(c.numero_apolice)}` : ''}` : t === 'outro' ? esc(c.objeto || '') : esc(c.indice_reajuste || '');
    const acoes = !ed ? '' : c._legado ? `<td class="acts"><button class="btn sec sm" data-a="ct-migrar" data-l="${esc(c.loja_ref)}">Migrar</button></td>`
      : `<td class="acts"><button class="iconbtn" data-a="ct-editar" data-id="${c.id}" aria-label="Editar">${ICON.editar}</button>${Auth.can('lojas.contratos.excluir') ? `<button class="btn ${inativo ? 'sec' : 'danger'} sm" data-a="ct-status" data-id="${c.id}">${inativo ? 'Reativar' : 'Inativar'}</button>` : ''}</td>`;
    return `<tr class="${inativo ? 'muted' : ''}"><td>${tipo}</td>
      <td><div class="cell-main">${esc(ContratosLocacao.rotuloLoja(c))}</div>${c.arquivo ? `<a class="cell-sub" href="${esc(Arquivos.url(c.arquivo))}" target="_blank" rel="noopener">${esc(c.arquivo.nome || 'documento.pdf')}</a>` : ''}</td>
      <td>${esc(ContratosLocacao.contraparte(c) || '—')}${c.extracaoIA ? ' <span class="pill info" title="Dados lidos do PDF pela IA e conferidos pelo gestor">IA</span>' : ''}<div class="cell-sub">${det}</div></td>
      <td class="mono">${Fmt.data(c.data_inicio)}</td><td class="mono">${c.data_vencimento ? Fmt.data(c.data_vencimento) : '<span class="hint">indeterminado</span>'}</td>
      <td class="num">${valor}</td><td>${radar}</td><td><span class="pill ${inativo ? 'neutral' : 'ok'}">${esc(c.status)}</span></td>${acoes}</tr>`;
  },
  /** Linhas da página atual via DocumentFragment + paginação sem re-render da tela. */
  montarLista() {
    const tb = $('#ctBody'); if (!tb) return;
    const lista = this._lista, pags = Math.max(1, Math.ceil(lista.length / CT_POR_PAGINA));
    this.ui.pagina = Math.min(Math.max(1, this.ui.pagina), pags);
    const i0 = (this.ui.pagina - 1) * CT_POR_PAGINA, fatia = lista.slice(i0, i0 + CT_POR_PAGINA);
    const tpl = document.createElement('template'); tpl.innerHTML = fatia.map(x => this.linhaHTML(x)).join('');
    const frag = document.createDocumentFragment(); frag.appendChild(tpl.content); tb.replaceChildren(frag);
    UI.rotularTabelas(tb.closest('.tbl-wrap'));
    const pg = $('#ctPager');
    if (pg) pg.innerHTML = lista.length > CT_POR_PAGINA ? `<div class="row between" style="margin-top:10px"><span class="hint">Linhas ${i0 + 1}–${i0 + fatia.length} de ${lista.length}</span>
      <div class="row"><button class="btn sec sm" data-a="ct-pag" data-d="-1" ${this.ui.pagina <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="hint">Página ${this.ui.pagina} de ${pags}</span><button class="btn sec sm" data-a="ct-pag" data-d="1" ${this.ui.pagina >= pags ? 'disabled' : ''}>Próxima ›</button></div></div>` : `<p class="hint" style="margin-top:10px">${lista.length} registro(s)</p>`;
  },

  /* ---------------- Formulário único (contrato · apólice) com leitor por IA ---------------- */
  opcoesCentro(sel) {
    const todos = RH.ativos('centros'), lojas = todos.filter(c => /^\d{3}\s*-/.test(c.nome.trim())), outros = todos.filter(c => !lojas.includes(c));
    const atual = sel && !todos.some(c => c.id === sel) ? RH.get('centros', sel) : null;
    const o = c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(RH.rotulo(c))}${c.status === 'inativo' ? ' (inativo)' : ''}</option>`;
    return `<option value="">Selecione a loja…</option>${atual ? o(atual) : ''}<optgroup label="Lojas">${lojas.map(o).join('')}</optgroup><optgroup label="Demais centros de custo">${outros.map(o).join('')}</optgroup>`;
  },
  /** Seleção múltipla de filiais (busca + marcar todas), lida por UI.lerForm como lista (data-lista). */
  multiLojas(sel = [], sugeridas = []) {
    const s = new Set(sel), lojas = Repo.todos('lojas').filter(l => l.ativa || s.has(l.id)).sort((a, b) => a.codigo.localeCompare(b.codigo));
    return `<div class="field full ms" data-ms><span class="lbl" id="msLbl">Filiais cobertas <span class="hint" data-ms-cont>(${s.size} selecionada${s.size === 1 ? '' : 's'})</span></span>
      <div class="ms-bar"><input type="search" placeholder="Filtrar filial…" data-ms-busca aria-label="Filtrar filiais"><button type="button" class="btn ghost sm" data-ms-todas>Marcar todas</button><button type="button" class="btn ghost sm" data-ms-nenhuma>Limpar</button></div>
      <div class="ms-lista" role="group" aria-labelledby="msLbl">${lojas.map(l => `<label class="check ${sugeridas.includes(l.id) ? 'ia-sug' : ''}" data-ms-item="${esc(RH.chave(l.codigo + ' ' + l.nome + ' ' + (l.cidade || '')))}"><input type="checkbox" name="lojas_ids" value="${l.id}" data-lista="1" ${s.has(l.id) ? 'checked' : ''}> ${esc(l.codigo)} · ${esc(l.nome)}${l.ativa ? '' : ' (inativa)'}</label>`).join('')}</div></div>`;
  },
  coberturasHTML(cob = []) {
    const linha = (x = {}) => `<tr><td><input type="text" data-cob="nome" value="${esc(x.nome || '')}" aria-label="Cobertura" placeholder="Ex.: Incêndio, raio e explosão"></td><td><input data-cob="limite" type="number" step="0.01" min="0" value="${x.limite ?? ''}" aria-label="Limite (LMI)"></td><td><input type="text" data-cob="franquia" value="${esc(x.franquia || '')}" aria-label="Franquia"></td><td><button type="button" class="iconbtn" data-cob-del aria-label="Remover cobertura">${ICON.lixo}</button></td></tr>`;
    return `<div class="field full"><span class="lbl">Coberturas</span><div class="tbl-wrap"><table class="nolabel matriz"><thead><tr><th>Cobertura</th><th>Limite (LMI) R$</th><th>Franquia</th><th></th></tr></thead><tbody data-cob-body>${(cob.length ? cob : [{}]).map(linha).join('')}</tbody></table></div>
      <button type="button" class="btn sec sm" style="margin-top:6px" data-cob-add>+ Cobertura</button><template data-cob-tpl>${linha()}</template></div>`;
  },
  camposLocacao(c) {
    const indices = c.indice_reajuste && !CT_INDICES.includes(c.indice_reajuste) ? [...CT_INDICES, c.indice_reajuste] : CT_INDICES;
    return `<div class="field full"><label class="lbl" for="f_loja_id">Loja (centro de custo)</label><select id="f_loja_id" name="loja_id">${this.opcoesCentro(c.loja_id)}</select>${c.loja_ref && !c.loja_id ? `<span class="hint" style="margin-top:4px">Vinculado à filial ${esc(ContratosLocacao.nomeLoja(c.loja_ref))} (sem centro de custo correspondente no Módulo 1).</span>` : ''}<input type="hidden" name="loja_ref" value="${esc(c.loja_ref || '')}"></div>
      ${campo('Locador', 'locador', c.locador, { full: true, attrs: 'required placeholder="Nome ou razão social do locador / administradora"' })}
      ${campo('Início do contrato', 'data_inicio', c.data_inicio, { tipo: 'date', attrs: 'required' })}
      ${campo('Vencimento do contrato', 'data_vencimento', c.data_vencimento, { tipo: 'date', attrs: 'required' })}
      ${campo('Índice de reajuste', 'indice_reajuste', c.indice_reajuste || 'IGP-M', { opcoes: indices })}
      ${campo('Próxima data-base de reajuste', 'data_base_reajuste', c.data_base_reajuste, { tipo: 'date', dica: 'Se vazio, usa o aniversário do início.' })}
      ${campo('Aluguel mínimo / fixo atual (R$/mês)', 'valor_atual', c.valor_atual, { tipo: 'number', attrs: 'min="0.01" required' })}
      ${campo('Aluguel percentual (% das vendas)', 'percentual_faturamento', c.percentual_faturamento ?? '', { tipo: 'number', attrs: 'min="0" max="100" placeholder="Ex.: 6"', dica: 'Paga-se o maior entre o mínimo e o % das vendas. Vazio = só aluguel fixo.' })}
      ${campo('Condomínio (R$/mês)', 'condominio', c.condominio ?? '', { tipo: 'number' })}${campo('Fundo de promoção (R$/mês)', 'fundo_promocao', c.fundo_promocao ?? '', { tipo: 'number' })}
      ${campo('Garantia', 'garantia', c.garantia, { attrs: 'placeholder="Fiança, seguro-fiança, caução…"' })}
      ${campo('Situação', 'status', c.status || 'Ativo', { opcoes: CT_STATUS })}
      <div class="field" id="ctPrevia" aria-live="polite"></div>
      ${campo('Observações', 'observacoes', c.observacoes, { tipo: 'textarea', full: true })}`;
  },
  camposOutro(c) {
    return `${campo('Outra parte (fornecedor / contratado)', 'contraparte', c.contraparte, { full: true, attrs: 'required' })}
      ${campo('Objeto do contrato', 'objeto', c.objeto, { full: true, attrs: 'required placeholder="Ex.: manutenção do ar-condicionado, comodato de equipamentos, prestação de serviços"' })}
      ${campo('Início', 'data_inicio', c.data_inicio, { tipo: 'date', attrs: 'required' })}${campo('Vencimento (vazio = indeterminado)', 'data_vencimento', c.data_vencimento, { tipo: 'date' })}
      ${campo('Valor mensal (R$)', 'valor_atual', c.valor_atual ?? '', { tipo: 'number' })}${campo('Índice de reajuste', 'indice_reajuste', c.indice_reajuste || '', { opcoes: [['', '—'], ...CT_INDICES.map(i => [i, i])] })}
      ${this.multiLojas(c.lojas_ids || [])}
      ${campo('Situação', 'status', c.status || 'Ativo', { opcoes: CT_STATUS })}
      ${campo('Observações', 'observacoes', c.observacoes, { tipo: 'textarea', full: true })}`;
  },
  camposSeguro(c, sugeridas = []) {
    const p = c.premios || {}, pg = c.pagamento || {}, ramos = c.ramo && !CT_RAMOS.includes(c.ramo) ? [...CT_RAMOS, c.ramo] : CT_RAMOS;
    return `${campo('Seguradora', 'seguradora', c.seguradora, { attrs: 'required' })}${campo('Nº da apólice', 'numero_apolice', c.numero_apolice)}
      ${campo('Ramo', 'ramo', c.ramo || CT_RAMOS[0], { opcoes: ramos })}${campo('Corretora', 'corretora', c.corretora)}
      ${campo('Início da vigência', 'data_inicio', c.data_inicio, { tipo: 'date', attrs: 'required' })}${campo('Fim da vigência', 'data_vencimento', c.data_vencimento, { tipo: 'date', attrs: 'required' })}
      ${this.coberturasHTML(c.coberturas || [])}
      ${campo('Carências', 'carencias', c.carencias, { tipo: 'textarea', full: true, attrs: 'rows="3" placeholder="Uma por linha. Ex.: Roubo — 30 dias do início da vigência"' })}
      <fieldset class="full ct-grupo"><legend>Prêmios</legend><div class="form-grid">
        ${campo('Prêmio líquido (R$)', 'premios.liquido', p.liquido ?? '', { tipo: 'number' })}${campo('Adicional de fracionamento (R$)', 'premios.adicional', p.adicional ?? '', { tipo: 'number' })}
        ${campo('IOF (R$)', 'premios.iof', p.iof ?? '', { tipo: 'number' })}${campo('Prêmio total (R$)', 'premios.total', p.total ?? '', { tipo: 'number' })}</div></fieldset>
      <fieldset class="full ct-grupo"><legend>Condições de pagamento</legend><div class="form-grid">
        ${campo('Forma de pagamento', 'pagamento.forma', pg.forma, { attrs: 'list="ctFormas" placeholder="Boleto, débito em conta…"' })}${campo('Nº de parcelas', 'pagamento.parcelas', pg.parcelas ?? '', { tipo: 'number', attrs: 'min="1" max="24"' })}
        ${campo('Valor da parcela (R$)', 'pagamento.valor_parcela', pg.valor_parcela ?? '', { tipo: 'number' })}${campo('1º vencimento', 'pagamento.primeiro_vencimento', pg.primeiro_vencimento, { tipo: 'date' })}
        ${campo('Observação do pagamento', 'pagamento.observacao', pg.observacao, { full: true })}<datalist id="ctFormas"><option value="Boleto"><option value="Débito em conta"><option value="Cartão de crédito"><option value="À vista"></datalist></div></fieldset>
      ${this.multiLojas(c.lojas_ids || [], sugeridas)}
      ${campo('Situação', 'status', c.status || 'Ativo', { opcoes: CT_STATUS })}
      ${campo('Observações', 'observacoes', c.observacoes, { tipo: 'textarea', full: true })}`;
  },
  /** Corpo do formulário: classificação do documento para a IA (Contrato | Apólice de seguro) + campos do tipo. */
  corpoForm(c, st) {
    const novo = !c.id, classe = st.tipo === 'seguro' ? 'seguro' : 'contrato';
    const leitor = novo ? `<div class="leitor-ia full">
        <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:nowrap"><div class="ic-ia">${ICON.ia}</div><div style="flex:1;min-width:0">
          <b>Leitor de documentos com IA</b>
          <div class="seg ct-classe" role="radiogroup" aria-label="Tipo do documento" style="margin:8px 0">
            <button type="button" role="radio" aria-checked="${classe === 'contrato'}" class="${classe === 'contrato' ? 'on' : ''}" data-classe="contrato">Contrato</button>
            <button type="button" role="radio" aria-checked="${classe === 'seguro'}" class="${classe === 'seguro' ? 'on' : ''}" data-classe="seguro">Apólice de Seguro</button></div>
          <p class="hint" style="margin:0 0 10px">${classe === 'seguro' ? 'Envie o PDF da apólice: a IA extrai coberturas, prêmios, carências e condições de pagamento e sugere as filiais pelos locais de risco.' : 'Envie o PDF do contrato: a IA preenche a outra parte, datas, índice e valores.'} Confira antes de salvar.</p>
          ${LeitorContratoIA.disponivel ? `<label class="btn sec sm" style="cursor:pointer">Escolher PDF${classe === 'seguro' ? ' da apólice' : ' do contrato'}<input type="file" accept="application/pdf,.pdf" hidden data-ct-pdf></label>` : `<span class="pill neutral">Leitura por IA desligada</span>${Arquivos.podeEnviar ? ` <label class="btn ghost sm" style="cursor:pointer">Anexar PDF sem leitura<input type="file" accept="application/pdf,.pdf" hidden data-ct-anexo></label>` : ''}`}
          <span class="hint" id="ctIaStatus" role="status" aria-live="polite" style="margin-left:8px"></span></div></div>
        <div id="ctIaResultado"></div></div>` : (c.extracaoIA ? `<div class="note full">Dados lidos do PDF pela IA em ${Fmt.dataHora(c.extracaoIA.em)} e conferidos no cadastro.</div>` : '');
    const natureza = classe === 'contrato' && novo ? `<div class="field full"><label class="lbl" for="f_tipo">Natureza do contrato</label><select id="f_tipo" data-ct-tipo><option value="locacao" ${st.tipo === 'locacao' ? 'selected' : ''}>Locação (entra no radar de renovatórias e no motor de aluguel)</option><option value="outro" ${st.tipo === 'outro' ? 'selected' : ''}>Outro contrato (serviços, comodato, manutenção…)</option></select></div>` : '';
    const campos = st.tipo === 'seguro' ? this.camposSeguro(c, st.sugeridas) : st.tipo === 'outro' ? this.camposOutro(c) : this.camposLocacao(c);
    return `<div class="form-grid">${leitor}${natureza}${campos}</div>`;
  },
  /** Prévia do radar enquanto o vencimento é digitado. */
  previa(m, tipo) {
    const alvo = $('#ctPrevia', m); if (!alvo || tipo !== 'locacao') return;
    const v = $('[name="data_vencimento"]', m)?.value, i = $('[name="data_inicio"]', m)?.value;
    if (!v) { alvo.innerHTML = ''; return; }
    const r = RadarRenovatoria.classificar({ data_vencimento: v, data_inicio: i });
    alvo.innerHTML = `<span class="lbl">Radar</span><div class="row" style="gap:6px">${this.pillZona(r)}<span class="hint">${esc(RadarRenovatoria.prazoTexto(r))}${r.zona === 'amarela' ? ` · ajuizar até ${Fmt.data(Datas.iso(r.janela.ate))}` : r.zona === 'verde' ? ` · janela abre em ${Fmt.data(Datas.iso(r.janela.de))}` : ''}</span></div>`;
  },
  lerCoberturas(m) { return $$('[data-cob-body] tr', m).map(tr => { const g = k => $(`[data-cob="${k}"]`, tr)?.value.trim() || ''; const lim = g('limite'); return { nome: g('nome'), limite: lim === '' ? null : Number(lim), franquia: g('franquia') }; }).filter(x => x.nome); },
  /**
   * Abre o formulário. pre = valores iniciais (ex.: { tipo:'seguro', lojas_ids:[...] } a partir da loja,
   * ou um contrato do cadastro da loja para a migração guiada).
   */
  abrirForm(id, pre = {}) {
    const c0 = id ? { ...ContratosLocacao.get(id), id } : { status: 'Ativo', indice_reajuste: 'IGP-M', ...pre };
    const st = { tipo: ContratosLocacao.tipo(c0), sugeridas: [] };
    let c = c0, pdf = null, extracao = null;
    const titulo = id ? `Editar · ${CT_TIPOS[st.tipo]}` : pre._migracao ? 'Migrar contrato do cadastro da loja' : 'Novo documento';
    const redesenhar = (m, lerTela = true) => {
      if (lerTela) { const cob = $('[data-cob-body]', m) ? this.lerCoberturas(m) : c.coberturas; c = { ...c, ...UI.lerForm(m), coberturas: cob }; }
      $('.body', m).innerHTML = this.corpoForm(c, st); this.previa(m, st.tipo); UI.rotularTabelas(m);
    };
    UI.modal({
      titulo, largo: true, corpo: this.corpoForm(c, st),
      aoAbrir: m => {
        this.previa(m, st.tipo);
        m.addEventListener('input', e => {
          if (['data_vencimento', 'data_inicio'].includes(e.target.name)) this.previa(m, st.tipo);
          e.target.closest('.field')?.classList.remove('ia-preenchido');
          if (e.target.matches('[data-ms-busca]')) { const q = RH.chave(e.target.value); $$('[data-ms-item]', m).forEach(x => { x.hidden = !!q && !x.dataset.msItem.includes(q); }); }
        });
        m.addEventListener('click', e => {
          const b = e.target.closest('[data-classe]');
          if (b) { const querSeguro = b.dataset.classe === 'seguro'; if (querSeguro !== (st.tipo === 'seguro')) { st.tipo = querSeguro ? 'seguro' : 'locacao'; extracao = null; st.sugeridas = []; redesenhar(m); } return; }
          if (e.target.closest('[data-cob-add]')) { const tpl = $('[data-cob-tpl]', m); $('[data-cob-body]', m).appendChild(tpl.content.cloneNode(true)); return; }
          const d = e.target.closest('[data-cob-del]'); if (d) { d.closest('tr').remove(); return; }
          const todas = e.target.closest('[data-ms-todas]'), nenh = e.target.closest('[data-ms-nenhuma]');
          if (todas || nenh) { $$('[data-ms-item]', m).forEach(x => { if (!x.hidden) $('input', x).checked = !!todas; }); this.contarMs(m); }
        });
        m.addEventListener('change', async e => {
          if (e.target.matches('[name="lojas_ids"]')) return this.contarMs(m);
          if (e.target.matches('[data-ct-tipo]')) { st.tipo = e.target.value; return redesenhar(m); }
          if (e.target.matches('[data-ct-anexo]')) { const f = e.target.files[0]; e.target.value = ''; if (f) { pdf = f; $('#ctIaStatus', m).textContent = f.name + ' · será anexado ao salvar'; } return; }
          if (!e.target.matches('[data-ct-pdf]')) return;
          const f = e.target.files[0]; e.target.value = ''; if (!f) return;
          const s = $('#ctIaStatus', m), res = $('#ctIaResultado', m);
          try {
            s.textContent = 'Preparando…'; res.innerHTML = '';
            const r = st.tipo === 'seguro' ? await LeitorContratoIA.lerApolice(f, t => { s.textContent = t; }) : await LeitorContratoIA.ler(f, t => { s.textContent = t; });
            pdf = f; extracao = r;
            if (st.tipo === 'seguro') {
              const tela = UI.lerForm(m), cobTela = this.lerCoberturas(m); c = { ...c, ...tela, coberturas: cobTela };
              st.sugeridas = r.lojasSugeridas; c = { ...c, ...this.mesclarApolice(r.dados, c), lojas_ids: [...new Set([...(tela.lojas_ids || []), ...r.lojasSugeridas])] };
              redesenhar(m, false); this.marcarApolice(m, r);
            }
            else this.preencher(m, r, st.tipo);
            $('#ctIaStatus', m).textContent = `${f.name} · ${r.paginas} página(s) lida(s)`;
          } catch (err) { $('#ctIaStatus', m).textContent = ''; $('#ctIaResultado', m).innerHTML = `<div class="note warn" style="margin-top:10px">Não foi possível ler o documento: ${esc(err.message || String(err))}. Preencha manualmente.</div>`; }
        });
      },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: id ? 'Salvar' : st.tipo === 'seguro' ? 'Salvar apólice' : 'Salvar contrato', acao: async m => {
        const d = UI.lerForm(m); d.tipo = st.tipo; d.lojas_ids = d.lojas_ids || [];
        if (st.tipo === 'seguro') { d.coberturas = this.lerCoberturas(m); d.pagamento = { ...(c0.pagamento || {}), ...(d.pagamento || {}), vencimentos: extracao?.dados?.pagamento?.vencimentos || c0.pagamento?.vencimentos || [] }; delete d.loja_id; }
        if (st.tipo === 'locacao') {
          d.valor_atual = Number(d.valor_atual); d.locador = String(d.locador || '').trim(); delete d.lojas_ids;
          d.percentual_faturamento = d.percentual_faturamento === '' || d.percentual_faturamento == null ? null : Number(String(d.percentual_faturamento).replace(',', '.'));
          if (!d.loja_ref && d.loja_id) { const l = ContratosLocacao.lojaDoCentro(RH.get('centros', d.loja_id)); if (l) d.loja_ref = l.id; }
          if (!d.loja_ref) delete d.loja_ref;
        }
        if (!d.data_vencimento) d.data_vencimento = '';
        const erros = ContratosLocacao.validar(d, id); if (erros.length) { UI.toast('Confira: ' + erros.join('; ') + '.'); return false; }
        if (extracao) {
          const campos = st.tipo === 'seguro' ? ['seguradora', 'numero_apolice', 'data_inicio', 'data_vencimento', 'coberturas', 'carencias', 'premios', 'pagamento'] : LeitorContratoIA.CAMPOS.filter(k => String(extracao.dados[k] ?? '') !== '');
          d.extracaoIA = { em: new Date().toISOString(), por: Auth.id, tipo: st.tipo === 'seguro' ? 'apolice' : 'contrato', arquivo: pdf?.name || '', paginas: extracao.paginas, campos, confianca: extracao.dados.confianca, lojasSugeridas: extracao.lojasSugeridas || undefined };
        }
        if (pdf && Arquivos.podeEnviar) { try { d.arquivo = await Arquivos.enviar(pdf); } catch (e) { UI.toast('Salvo sem o PDF anexo: ' + (e.message || 'armazenamento indisponível')); } }
        await ContratosLocacao.salvar(id, d, id ? 'Editado' : pre._migracao ? 'Migrado do cadastro da loja' : extracao ? 'Criado com leitura por IA' : 'Criado');
        UI.toast(id ? 'Registro atualizado' : st.tipo === 'seguro' ? 'Apólice cadastrada' : 'Contrato cadastrado');
      } }],
    });
  },
  contarMs(m) { const n = $$('[name="lojas_ids"]:checked', m).length, el = $('[data-ms-cont]', m); if (el) el.textContent = `(${n} selecionada${n === 1 ? '' : 's'})`; },
  /** Junta o que a IA leu da apólice com o formulário (o que a IA não achou não apaga o que já estava). */
  mesclarApolice(d, c) {
    const v = (a, b) => (a !== '' && a != null ? a : b);
    return { seguradora: v(d.seguradora, c.seguradora), numero_apolice: v(d.numero_apolice, c.numero_apolice), ramo: v(d.ramo, c.ramo), corretora: v(d.corretora, c.corretora), segurado: v(d.segurado, c.segurado),
      data_inicio: v(d.data_inicio, c.data_inicio), data_vencimento: v(d.data_vencimento, c.data_vencimento), coberturas: d.coberturas.length ? d.coberturas : (c.coberturas || []),
      premios: { ...(c.premios || {}), ...Object.fromEntries(Object.entries(d.premios).filter(([, x]) => x != null)) },
      pagamento: { ...(c.pagamento || {}), ...Object.fromEntries(Object.entries(d.pagamento).filter(([k, x]) => x != null && x !== '' && k !== 'vencimentos')) },
      carencias: v(d.carencias, c.carencias), observacoes: c.observacoes || d.observacoes };
  },
  marcarApolice(m, r) {
    const d = r.dados;
    ['seguradora', 'numero_apolice', 'data_inicio', 'data_vencimento', 'carencias', 'premios.total', 'premios.liquido', 'premios.iof', 'pagamento.forma', 'pagamento.parcelas', 'pagamento.valor_parcela', 'pagamento.primeiro_vencimento']
      .forEach(n => { const el = $(`[name="${n}"]`, m); if (el && el.value) el.closest('.field')?.classList.add('ia-preenchido'); });
    const sug = r.lojasSugeridas;
    $('#ctIaResultado', m).innerHTML = `<div class="note ${d.coberturas.length && d.data_vencimento ? '' : 'warn'}" style="margin-top:12px">
      <b>Apólice lida pela IA:</b> ${d.coberturas.length} cobertura(s)${d.carencias ? ` · ${d.carencias.split('\n').length} carência(s)` : ''}${d.premios.total ? ` · prêmio total ${Fmt.brl(d.premios.total)}` : ' · prêmio não encontrado'}${d.pagamento.parcelas ? ` · ${d.pagamento.parcelas}x de ${Fmt.brl(d.pagamento.valor_parcela)}` : ''}.
      ${sug.length ? `${sug.length} filial(is) marcada(s) pelos locais de risco (destacadas na lista): confira.` : 'Nenhuma filial reconhecida nos locais de risco: marque as filiais cobertas.'} Os campos destacados vieram do PDF.
      ${d.locais.length ? `<details class="log" style="margin-top:6px"><summary>Locais de risco citados na apólice</summary>${d.locais.map(x => `<div class="chg">${esc(x)}</div>`).join('')}</details>` : ''}
      ${d.observacoes ? `<details class="log"><summary>Pontos para conferir (IA)</summary><div class="chg">${esc(d.observacoes)}</div></details>` : ''}</div>`;
  },
  /** Preenche o formulário de contrato com o que a IA extraiu e mostra confiança + trechos para conferência. */
  preencher(m, r, tipo) {
    const d = r.dados, conf = d.confianca || {}, ev = d.evidencias || {};
    const rot = { locador: tipo === 'outro' ? 'Outra parte' : 'Locador', data_inicio: 'Início', data_vencimento: 'Vencimento', indice_reajuste: 'Índice', valor_atual: 'Valor', percentual_faturamento: '% das vendas' };
    const set = (nome, v) => {
      const el = $(`[name="${nome}"]`, m); if (!el || v == null || v === '') return false;
      if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(v))) el.add(new Option(String(v), String(v)));
      el.value = String(v); el.closest('.field')?.classList.add('ia-preenchido'); return true;
    };
    const mapa = tipo === 'outro' ? { locador: 'contraparte' } : {};
    const ok = LeitorContratoIA.CAMPOS.filter(k => set(mapa[k] || k, d[k]));
    if (tipo === 'outro' && d.observacoes) set('objeto', $('[name="objeto"]', m)?.value || d.observacoes.slice(0, 140));
    const cc = $('[name="loja_id"]', m), sug = r.centroSugerido || { centro: null, candidatos: [] };
    if (cc && !cc.value && sug.centro) { cc.value = sug.centro.id; cc.closest('.field')?.classList.add('ia-preenchido'); }
    this.previa(m, tipo);
    const obrig = LeitorContratoIA.CAMPOS.filter(k => k !== 'percentual_faturamento'), faltam = obrig.filter(k => !ok.includes(k)), okObrig = obrig.filter(k => ok.includes(k));
    $('#ctIaResultado', m).innerHTML = `<div class="note ${faltam.length ? 'warn' : ''}" style="margin-top:12px">
      <b>${okObrig.length} de ${obrig.length} campos preenchidos pela IA</b>${tipo === 'locacao' ? (ok.includes('percentual_faturamento') ? ` · aluguel percentual: ${Fmt.pct(d.percentual_faturamento)} das vendas` : ' · sem cláusula de aluguel percentual') : ''}${tipo === 'locacao' ? (sug.centro && cc?.value === sug.centro.id ? ` · loja sugerida pelo imóvel: ${esc(RH.rotulo(sug.centro))}` : sug.candidatos.length > 1 ? ` · o imóvel pode ser ${sug.candidatos.map(x => esc(RH.rotulo(x))).join(' ou ')}: escolha a loja` : ' · escolha a loja') : ''}. Os campos destacados vieram do PDF: confira antes de salvar.
      ${faltam.length ? `<div>Não encontrados: ${faltam.map(k => rot[k]).join(', ')}.</div>` : ''}
      <details class="log" style="margin-top:6px"><summary>Ver trechos do contrato usados</summary>${LeitorContratoIA.CAMPOS.map(k => `<div class="chg"><b>${rot[k]}</b>${conf[k] ? ` · confiança ${esc(conf[k])}` : ''}: ${esc(ev[k] || '—')}</div>`).join('')}
      ${d.imovel ? `<div class="chg"><b>Imóvel</b>: ${esc(d.imovel)}</div>` : ''}${d.observacoes ? `<div class="chg"><b>Observações da IA</b>: ${esc(d.observacoes)}</div>` : ''}</details></div>`;
    const obs = $('[name="observacoes"]', m); if (obs && !obs.value && d.observacoes) { obs.value = d.observacoes; obs.closest('.field')?.classList.add('ia-preenchido'); }
  },
  /** Migração guiada: abre o formulário já preenchido com o contrato que está só no cadastro da loja. */
  migrar(lojaId) {
    const l = Repo.get('lojas', lojaId), leg = ContratosLocacao.legadoDaLoja(l); if (!leg) return UI.toast('Este contrato já está na tabela global.');
    const cc = ContratosLocacao.centroDaLoja(l), { id: _, _legado, ...x } = leg;
    this.abrirForm(null, { ...x, loja_id: cc?.id || '', status: 'Ativo', _migracao: true });
  },

  /* ---------------- eventos (prefixo ct-) ---------------- */
  async acao(a, el) {
    const u = this.ui;
    switch (a) {
      case 'ct-aba': u.aba = el.dataset.v; return App.render();
      case 'ct-novo': return this.abrirForm(null, el.dataset.t === 'seguro' ? { tipo: 'seguro', ...(el.dataset.l ? { lojas_ids: [el.dataset.l] } : {}) } : el.dataset.l ? { tipo: 'locacao', loja_ref: el.dataset.l, loja_id: ContratosLocacao.centroDaLoja(Repo.get('lojas', el.dataset.l))?.id || '' } : {});
      case 'ct-editar': return this.podeEd() ? this.abrirForm(el.dataset.id) : null;
      case 'ct-migrar': return this.podeEd() ? this.migrar(el.dataset.l) : null;
      case 'ct-ir': App.ir('contratos'); return;
      case 'ct-status': {
        if (!Auth.can('lojas.contratos.excluir')) return UI.toast('Inativar contratos e apólices não está liberado para o seu acesso.');
        const c = ContratosLocacao.get(el.dataset.id), novo = c.status === 'Inativo' ? 'Ativo' : 'Inativo', t = ContratosLocacao.tipo(c);
        if (novo === 'Ativo' && t === 'locacao') { const outro = (c.loja_id && ContratosLocacao.ativoDoCentro(c.loja_id, c.id)) || (c.loja_ref && ContratosLocacao.ativoDaLojaRef(c.loja_ref, c.id)); if (outro) return UI.toast(`Já há contrato ativo para ${ContratosLocacao.rotuloLoja(outro)}. Inative-o antes.`); }
        if (!(await UI.confirmar(novo === 'Inativo' ? 'Inativar' : 'Reativar', `${novo === 'Inativo' ? 'Inativar' : 'Reativar'} ${t === 'seguro' ? 'a apólice' : 'o contrato'} <b>${esc(ContratosLocacao.contraparte(c) || '')}</b> · ${esc(ContratosLocacao.rotuloLoja(c))}${c.data_vencimento ? ` (vence ${Fmt.data(c.data_vencimento)})` : ''}?${novo === 'Inativo' ? ' Sai dos radares, mas o histórico fica guardado.' : ''}`, novo === 'Inativo' ? 'Inativar' : 'Reativar', novo === 'Inativo'))) return;
        return ContratosLocacao.alterarStatus(c.id, novo);
      }
      case 'ct-pag': u.pagina += Number(el.dataset.d); this.montarLista(); return $('#ctTabela')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      case 'ct-radar-todos': u.radarTodos = !u.radarTodos; return App.render();
    }
  },
  mudanca(a, el) { if (a === 'ct-filtro') { this.ui[el.dataset.k] = el.value; this.ui.pagina = 1; return App.render(); } },
  entrada(a, el) { if (a === 'ct-busca') { this.ui.busca = el.value; this.ui.pagina = 1; App.render(); } },
};
document.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.rd-row[data-a], .seg-alertas li[data-a]')) { e.preventDefault(); e.target.click(); } });
