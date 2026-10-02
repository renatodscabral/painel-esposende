/* =====================================================================
   MÓDULO 3 — FCX · aba "DFC" (realizado bancário × premissas do FCX)
   Camadas 6 (Serviços) e 7 (UI). Veio da Retaguarda Financeira (Módulo 4):
     • Extratos OFX       — importação, deduplicação (FITID) e reclassificação manual
     • Contas bancárias   — de-para OFX → conta
     • Regras             — classificação automática das transações nas categorias da DFC
     • DFC do mês         — Demonstração dos Fluxos de Caixa (método direto)
     • Realizado × Previsto — cruza a DFC com o que o FCX já projeta (vendas por meio de
       pagamento, prestação, saídas por conta contábil) no mês escolhido.
   O "previsto" é lido do próprio FCX (iframe, via window.FCXAPI): nada é redigitado.
   Coleções: extratos, contasBancarias, dfc (resumo mensal), config/dfc (regras + mapaFCX),
             config/fcx_saldos (saldo inicial manual, opcional). Só GESTOR (regra do banco: admin).
   ===================================================================== */
const PARTE_EXTRATO = 900; // transações por documento (≈ 110 KB, abaixo do limite de 256 KB)

/** Meio de pagamento do FCX → categoria de entrada da DFC. */
const FCX_METODO_PARA_DFC = {
  dinheiro: 'rec_depositos', pix: 'rec_pix', credito: 'rec_cartoes', debito: 'rec_cartoes',
  esposende_card: 'rec_credsystem', crediario: 'rec_credsystem', deposito: 'rec_outros', vale: 'rec_outros', creditocliente: 'rec_outros',
};
/** Conta contábil do FCX → categoria de saída da DFC, pelo prefixo do código (ajustável conta a conta em config/dfc.mapaFCX). */
const FCX_CONTA_PARA_DFC = [
  [/^7\.01\.05/, 'pag_repasse_credsystem'],
  [/^2\.(02|14)/, 'pag_fornecedores'],
  [/^4\.(0[1-6])\.|^4\.38\.17|^7\.21/, 'pag_folha'],
  [/^4\.10\.(08|09)|^4\.09\.0[46]/, 'pag_utilidades'],
  [/^4\.10\./, 'pag_ocupacao'],
  [/^7\.11\./, 'pag_impostos'],
  [/^7\.20\.|^4\.26\./, 'inv_capex'],
  [/^4\.33\./, 'pag_marketing'],
  [/^4\.(09|12|15|18|23|38)\./, 'pag_administrativas'],
];

/* =====================================================================
   PREVISTO — premissas do FCX agregadas nas categorias da DFC
   ===================================================================== */
const PrevistoFCX = {
  _memo: new Map(),
  mapa() { return Repo.get('config', 'dfc')?.mapaFCX || {}; },
  categoriaPadrao(conta) {
    const cod = String(conta || '').split('–')[0].trim();
    return (FCX_CONTA_PARA_DFC.find(([re]) => re.test(cod)) || [, 'pag_outros'])[1];
  },
  categoriaDaConta(conta, mapa = this.mapa()) { return mapa[conta] || this.categoriaPadrao(conta); },
  /** Chave do livro-caixa do FCX → { cat, rotulo }. */
  entrada(k, api) {
    const [tipo, m] = k.split(':');
    const nome = api.metodos[m] || m;
    return { cat: FCX_METODO_PARA_DFC[m] || 'rec_outros', rotulo: tipo === 'prestacao_entrada' ? `Prestação recebida via ${nome}` : `Vendas · ${nome} (líquido)` };
  },
  saida(k, mapa) {
    if (k.startsWith('prestacao_repasse:')) { const conta = k.slice(18); return { cat: this.categoriaDaConta(conta, mapa), rotulo: conta + ' (projeção da prestação)', conta }; }
    const partes = k.split(':'); partes.pop(); const conta = partes.slice(1).join(':');
    return { cat: this.categoriaDaConta(conta, mapa), rotulo: conta, conta };
  },
  /**
   * Previsto do mês: { porCat:{cat:{valor,itens:{rotulo:valor}}}, porDia:{iso:{entradas,saidas}}, vencidos, contas }
   * Regras de período: vendas e prestação entram na data de RECEBIMENTO (prazo do meio de pagamento, dia útil);
   * saídas na data de vencimento (fim de semana/feriado → próximo dia útil), como na visão do FCX.
   */
  doMes(mes, hoje = Datas.hojeISO()) {
    const api = FCX.api(); if (!api) return null;
    const chave = [mes, hoje, FCX.versao, JSON.stringify(this.mapa())].join('|');
    if (this._memo.has(chave)) return this._memo.get(chave);
    const ini = mes + '-01', fim = Datas.iso(new Date(+mes.slice(0, 4), +mes.slice(5, 7), 0));
    const book = api.livro(ini, fim), mapa = this.mapa();
    const porCat = {}, porDia = {}, contas = new Set();
    const add = (cat, rotulo, valor, iso, e) => {
      const c = porCat[cat] ||= { valor: 0, itens: {} }; c.valor += valor; c.itens[rotulo] = (c.itens[rotulo] || 0) + valor;
      const d = porDia[iso] ||= { entradas: 0, saidas: 0 }; d[e ? 'entradas' : 'saidas'] += valor;
    };
    for (const [iso, b] of Object.entries(book)) {
      for (const [k, v] of Object.entries(b.entradas)) { const x = this.entrada(k, api); add(x.cat, x.rotulo, v, iso, true); }
      for (const [k, v] of Object.entries(b.saidas)) { const x = this.saida(k, mapa); if (x.conta) contas.add(x.conta); add(x.cat, x.rotulo, v, iso, false); }
    }
    // saídas já vencidas e não pagas (tipo ≠ "pago" no FCX) — do mês e de meses anteriores
    const venc = { mes: { valor: 0, n: 0 }, anterior: { valor: 0, n: 0 } };
    for (const s of api.saidas()) {
      if (s.tipo === 'pago' || !s.date || s.date >= hoje) continue;
      const alvo = s.date.startsWith(mes) ? venc.mes : s.date < ini ? venc.anterior : null;
      if (alvo) { alvo.valor += Number(s.valor) || 0; alvo.n++; }
    }
    const r = { porCat, porDia, vencidos: venc, contas: [...contas].sort() };
    if (this._memo.size > 24) this._memo.clear();
    this._memo.set(chave, r);
    return r;
  },
};

/* =====================================================================
   CRUZAMENTO — Realizado (DFC via OFX) × Previsto (FCX), mês a mês
   ===================================================================== */
const Cruzamento = {
  saldoInicial(mes) {
    const manual = Repo.get('config', 'fcx_saldos')?.saldosIniciais?.[mes];
    if (manual != null && manual !== '') return { valor: Number(manual), origem: 'informado manualmente' };
    const ant = Retaguarda.mesAnterior(mes), docs = Repo.todos('extratos').filter(d => d.mes === ant && d.saldo?.valor != null);
    if (docs.length) return { valor: docs.reduce((a, d) => a + d.saldo.valor, 0), origem: `saldo dos extratos em ${Fmt.data(docs.map(d => d.saldo.data).sort().at(-1))}` };
    return { valor: 0, origem: 'não informado (considerado zero)' };
  },
  calcular(mes, hoje = Datas.hojeISO()) {
    const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
    const prev = PrevistoFCX.doMes(mes, hoje) || { porCat: {}, porDia: {}, vencidos: { mes: { valor: 0, n: 0 }, anterior: { valor: 0, n: 0 } }, contas: [] };
    const tr = FluxoDFC.transacoes().filter(t => t.data.startsWith(mes));
    const dfc = DFC.consolidar(tr, DFC.regras());
    const ini = mes + '-01', fimMes = Datas.iso(new Date(+mes.slice(0, 4), +mes.slice(5, 7), 0));
    const encerrado = fimMes < hoje, futuro = ini > hoje;
    const cats = DFC_CATEGORIAS.filter(c => c.grupo !== 'TRANSFERENCIA');
    const pv = id => prev.porCat[id]?.valor || 0;

    // KPIs
    const recPrev = r2(cats.filter(c => c.sentido === 'E').reduce((a, c) => a + pv(c.id), 0));
    const recReal = r2(cats.filter(c => c.sentido === 'E' && c.grupo === 'OPERACIONAL').reduce((a, c) => a + Math.max(0, dfc.porCategoria[c.id]?.valor || 0), 0));
    const despPrev = r2(cats.filter(c => c.sentido !== 'E').reduce((a, c) => a + pv(c.id), 0));
    const despReal = dfc.saidas;

    // linhas categoria a categoria (valores absolutos; diferença = realizado − previsto)
    const linhas = cats.map(c => {
      const previsto = r2(pv(c.id)), realizado = r2(Math.abs(dfc.porCategoria[c.id]?.valor || 0)), dif = r2(realizado - previsto);
      const itens = Object.entries(prev.porCat[c.id]?.itens || {}).sort((a, b) => b[1] - a[1]);
      return { ...c, previsto, realizado, dif, pct: previsto ? realizado / previsto : null, favoravel: c.sentido === 'E' ? dif >= 0 : dif <= 0, itens, nReal: dfc.porCategoria[c.id]?.n || 0 };
    }).filter(l => l.previsto || l.realizado);

    // projeção de fechamento
    const saldo = this.saldoInicial(mes);
    const liq = iso => (prev.porDia[iso]?.entradas || 0) - (prev.porDia[iso]?.saidas || 0);
    const dias = [], ultimo = +fimMes.slice(8);
    const isoDia = d => `${mes}-${String(d).padStart(2, '0')}`;
    let previstoRestante = 0; for (let d = 1; d <= ultimo; d++) if (isoDia(d) >= hoje) previstoRestante += liq(isoDia(d));
    const previstoMes = Object.keys(prev.porDia).reduce((a, iso) => a + liq(iso), 0);
    const vencMes = prev.vencidos.mes.valor;
    const saldoFinalPrevisto = r2(encerrado ? saldo.valor + dfc.liquido : futuro ? saldo.valor + previstoMes : saldo.valor + dfc.liquido + previstoRestante - vencMes);

    // série diária: realizado (OFX) até hoje · projetado daí em diante · previsto original do FCX no mês todo
    let acum = saldo.valor, plano = saldo.valor, proj = null;
    for (let d = 1; d <= ultimo; d++) {
      const iso = isoDia(d), r = dfc.porDia[iso];
      plano += liq(iso);
      const ponto = { iso, real: null, proj: null, plano: r2(plano) };
      if (futuro) { proj = (proj ?? saldo.valor) + liq(iso); ponto.proj = r2(proj); }
      else if (iso < hoje || encerrado) { acum += r ? r.entradas - r.saidas : 0; ponto.real = r2(acum); }
      else if (iso === hoje) { acum += r ? r.entradas - r.saidas : 0; ponto.real = r2(acum); proj = acum - vencMes + liq(iso); ponto.proj = r2(d === ultimo ? proj : acum); }
      else { proj = (proj ?? acum) + liq(iso); ponto.proj = r2(proj); }
      dias.push(ponto);
    }
    return {
      mes, hoje, encerrado, futuro, saldo, saldoFinalPrevisto, dfc, linhas, dias, previstoRestante: r2(previstoRestante), previstoMes: r2(previstoMes),
      receitas: { previsto: recPrev, realizado: recReal, taxa: recPrev ? recReal / recPrev : null },
      despesas: { previsto: despPrev, realizado: despReal, variancia: r2(despReal - despPrev) },
      atrasos: { total: r2(vencMes), n: prev.vencidos.mes.n, estoqueAnterior: r2(prev.vencidos.anterior.valor), nAnterior: prev.vencidos.anterior.n },
      semRealizado: !tr.length, semPrevisto: !Object.keys(prev.porCat).length, fcxPronto: !!FCX.api(), contasFCX: prev.contas,
    };
  },
};

/* =====================================================================
   UI — aba DFC do Módulo 3
   ===================================================================== */
const FluxoDFC = {
  ui: { sub: 'cruzamento', mes: '', conta: '', filtro: 'todas', busca: '', limite: 200 },
  _charts: {},
  /* utilitários compartilhados com o Módulo 4 */
  mesLabel: mk => Retaguarda.mesLabel(mk),
  mesAtual: () => Datas.hojeISO().slice(0, 7),
  norm: s => Retaguarda.norm(s),
  r2: n => Math.round((n + Number.EPSILON) * 100) / 100,
  nomeLoja: (id, t) => Retaguarda.nomeLoja(id, t),
  cor: v => Retaguarda.cor(v),
  bloqueado: (t, x) => Retaguarda.bloqueado(t, x),
  async grafico(id, config) {
    const Chart = await Libs.chart(); const cv = document.getElementById(id); if (!cv) return;
    if (this._charts[id]) this._charts[id].destroy();
    this._charts[id] = new Chart(cv, config);
  },

  /* =====================================================================
     CONCILIAÇÃO BANCÁRIA · dados
     ===================================================================== */
  transacoes() {
    return Repo.todos('extratos').flatMap(d => (d.transacoes || []).map(t => ({ ...t, contaId: d.contaId, docId: d.id })));
  },
  mesesBanco() { return [...new Set(Repo.todos('extratos').map(d => d.mes))].sort().reverse(); },
  contas() { return Repo.todos('contasBancarias').sort((a, b) => (a.apelido || '').localeCompare(b.apelido || '')); },
  docsDaConta(contaId, mes) { return Repo.todos('extratos').filter(d => d.contaId === contaId && d.mes === mes).sort((a, b) => (a.parte || 0) - (b.parte || 0)); },

  /** Grava as transações de uma conta/mês em partes de até PARTE_EXTRATO, mesclando pelo FITID. */
  async gravarExtrato(contaId, mes, novas, extras = {}) {
    const docs = this.docsDaConta(contaId, mes), mapa = new Map();
    docs.flatMap(d => d.transacoes || []).forEach(t => mapa.set(t.id, t));
    let inseridas = 0;
    novas.forEach(t => { if (!mapa.has(t.id)) { mapa.set(t.id, t); inseridas++; } });
    const todas = [...mapa.values()].sort((a, b) => a.data.localeCompare(b.data));
    const base = docs[0] || {}, conta = Repo.get('contasBancarias', contaId);
    const arquivos = [...(base.arquivos || []), ...(extras.arquivo ? [extras.arquivo] : [])].slice(-10);
    const saldo = extras.saldo && extras.saldo.data?.startsWith(mes) ? extras.saldo : base.saldo || null;
    const partes = Math.max(1, Math.ceil(todas.length / PARTE_EXTRATO));
    for (let p = 0; p < partes; p++) {
      await Repo.salvar('extratos', `${contaId}_${mes}_${p}`, { contaId, mes, parte: p, transacoes: todas.slice(p * PARTE_EXTRATO, (p + 1) * PARTE_EXTRATO), ...(p === 0 ? { saldo, arquivos } : {}) },
        { modulo: 'fcx', rotulo: `Extrato ${ContasBancarias.rotulo(conta)} · ${this.mesLabel(mes)}${partes > 1 ? ` (parte ${p + 1})` : ''}`, detalhe: extras.detalhe || '' });
    }
    for (const d of docs) if ((d.parte || 0) >= partes) await Repo.excluir('extratos', d.id, { modulo: 'fcx', rotulo: 'Parte de extrato redistribuída' });
    return inseridas;
  },
  /** Atualiza a base de KPIs da DFC (dfc/AAAA-MM) — chamada a cada importação ou reclassificação. */
  async atualizarBaseDFC(meses) {
    const regras = DFC.regras();
    for (const mes of meses) {
      const tr = this.transacoes().filter(t => t.data.startsWith(mes));
      const c = DFC.consolidar(tr, regras);
      const porConta = {};
      Repo.todos('extratos').filter(d => d.mes === mes && d.saldo).forEach(d => { porConta[d.contaId] = { ...(c.porConta[d.contaId] || {}), saldoFinal: d.saldo.valor, saldoData: d.saldo.data }; });
      await Repo.salvar('dfc', mes, { mes, entradas: c.entradas, saidas: c.saidas, liquido: c.liquido, transferencias: c.transferencias, semRegra: c.semRegra, transacoes: c.n,
        porGrupo: c.porGrupo, porCategoria: c.porCategoria, porConta: { ...c.porConta, ...porConta }, porDia: c.porDia, atualizadoEm: new Date().toISOString() },
        { modulo: 'fcx', rotulo: 'Base DFC ' + this.mesLabel(mes), detalhe: 'Recalculada a partir dos extratos' });
    }
  },

  /** Importação OFX: lê, vincula às contas (pedindo cadastro quando faltar), deduplica e grava. */
  async importarOFX(arquivos) {
    const lidos = [];
    for (const f of arquivos) {
      const texto = OFX.decodificar(await f.arrayBuffer());
      OFX.ler(texto).forEach(e => lidos.push({ ...e, arquivo: f.name }));
    }
    const plano = [];
    for (const e of lidos) {
      let v = ContasBancarias.vincular(e.conta, this.contas());
      if (!v) { const nova = await this.perguntarConta(e); if (!nova) { plano.push({ e, ignorado: true }); continue; } v = { conta: nova, criterio: 'cadastrada agora' }; }
      const existentes = new Set(this.transacoes().filter(t => t.contaId === v.conta.id).map(t => t.id));
      const novas = e.transacoes.filter(t => !existentes.has(t.id));
      plano.push({ e, conta: v.conta, criterio: v.criterio, novas, duplicadas: e.transacoes.length - novas.length });
    }
    const validos = plano.filter(p => !p.ignorado);
    if (!validos.length) return UI.toast('Nada importado.');
    const texto = validos.map(p => `<div style="margin-bottom:8px"><b>${esc(ContasBancarias.rotulo(p.conta))}</b> <span class="hint">(${esc(p.criterio)})</span><br>
      ${Fmt.data(p.e.periodo.inicio)} a ${Fmt.data(p.e.periodo.fim)} · <b>${p.novas.length}</b> transação(ões) nova(s)${p.duplicadas ? ` · ${p.duplicadas} já importada(s) e ignorada(s)` : ''}${p.e.saldo ? ` · saldo ${Fmt.brl(p.e.saldo.valor)} em ${Fmt.data(p.e.saldo.data)}` : ''}</div>`).join('')
      + (plano.length > validos.length ? `<p class="hint">${plano.length - validos.length} extrato(s) ignorado(s) por não ter conta cadastrada.</p>` : '');
    if (!(await UI.confirmar('Importar extratos OFX', texto, 'Importar'))) return;
    const meses = new Set(); let total = 0;
    for (const p of validos) {
      const porMes = {}; p.novas.forEach(t => (porMes[t.data.slice(0, 7)] ||= []).push(t));
      if (p.e.saldo?.data) porMes[p.e.saldo.data.slice(0, 7)] ||= [];
      for (const [mes, lista] of Object.entries(porMes)) {
        total += await this.gravarExtrato(p.conta.id, mes, lista, { saldo: p.e.saldo, arquivo: { nome: p.e.arquivo, em: new Date().toISOString(), por: Auth.id, novas: lista.length }, detalhe: `Importação OFX ${p.e.arquivo}: ${lista.length} nova(s)` });
        meses.add(mes); await sleep(60);
      }
      await Repo.salvar('contasBancarias', p.conta.id, { ...Repo.get('contasBancarias', p.conta.id), ultimaImportacao: new Date().toISOString(), ultimoSaldo: p.e.saldo || null }, { modulo: 'fcx', rotulo: 'Conta ' + ContasBancarias.rotulo(p.conta) });
    }
    await this.atualizarBaseDFC([...meses]);
    this.ui.mes = [...meses].sort().at(-1);
    UI.toast(`${total} transação(ões) importada(s); DFC atualizada.`);
  },
  /** Conta do OFX não cadastrada: oferece o cadastro já preenchido (retorna a conta ou null). */
  perguntarConta(e) {
    return new Promise(ok => {
      let criada = null;
      const s = ContasBancarias.sugestao(e.conta);
      UI.modal({
        titulo: 'Conta do OFX não cadastrada', largo: true,
        corpo: `<div class="note warn" style="margin-bottom:12px">O arquivo <b>${esc(e.arquivo)}</b> traz a conta Banco <b>${esc(e.conta.bankId)}</b> · Agência <b>${esc(e.conta.branchId || '—')}</b> · Conta <b>${esc(e.conta.acctId)}</b>, que ainda não está no de-para. Confira e cadastre para continuar.</div>${this.formConta(s)}`,
        acoes: [{ rotulo: 'Ignorar este extrato', classe: 'sec' }, { rotulo: 'Cadastrar e continuar', acao: async m => { criada = await this.salvarConta(m, null); if (!criada) return false; } }],
      });
      const obs = new MutationObserver(() => { if (!$('#modais').querySelector('.overlay')) { obs.disconnect(); ok(criada); } });
      obs.observe($('#modais'), { childList: true });
    });
  },
  formConta(c = {}) {
    return `<div class="form-grid">
      ${campo('Apelido da conta', 'apelido', c.apelido, { attrs: 'placeholder="Ex.: Itaú Movimento Lojas"' })}
      ${campo('Banco', 'banco', c.banco, { opcoes: [['', 'Selecione…'], ...BANCOS.map(([k, n]) => [k, `${k} · ${n}`]), ...(c.banco && !BANCOS.some(b => b[0] === c.banco) ? [[c.banco, c.banco + ' · outro']] : [])] })}
      ${campo('Agência', 'agencia', c.agencia, { attrs: 'inputmode="numeric"' })}
      <div class="field"><span class="lbl">Conta e dígito</span><div class="row" style="flex-wrap:nowrap"><input type="text" name="conta" value="${esc(c.conta || '')}" aria-label="Conta" inputmode="numeric"><input type="text" name="digito" value="${esc(c.digito || '')}" aria-label="Dígito" style="max-width:70px"></div></div>
      ${campo('Tipo', 'tipo', c.tipo || 'Conta corrente', { opcoes: ['Conta corrente', 'Conta de arrecadação', 'Poupança', 'Aplicação', 'Cartão de crédito'] })}
      ${campo('Loja vinculada (opcional)', 'lojaId', c.lojaId || '', { opcoes: [['', 'Matriz / administrativo'], ...Repo.todos('lojas').filter(l => l.ativa).sort((a, b) => a.codigo.localeCompare(b.codigo)).map(l => [l.id, `${l.codigo} · ${l.nome}`])] })}
      ${campo('Identificador no OFX (ACCTID)', 'ofxAcctId', c.ofxAcctId, { dica: 'Opcional. Use quando o banco envia a conta num formato diferente (ex.: com agência ou zeros).' })}
      <div class="field"><span class="lbl">Situação</span><label class="check" style="padding-top:8px"><input type="checkbox" name="ativa" ${c.ativa !== false ? 'checked' : ''}> Conta ativa</label></div></div>`;
  },
  async salvarConta(m, id) {
    const d = UI.lerForm(m);
    if (!d.banco || !d.conta) { UI.toast('Informe banco e conta.'); return null; }
    d.bancoNome = (BANCOS.find(b => b[0] === d.banco) || [])[1] || d.banco;
    if (!d.apelido) d.apelido = d.bancoNome;
    const dup = this.contas().find(c => c.id !== id && ContasBancarias.semZero(c.banco) === ContasBancarias.semZero(d.banco) && ContasBancarias.semZero(c.conta) === ContasBancarias.semZero(d.conta));
    if (dup) { UI.toast('Esta conta já está cadastrada: ' + ContasBancarias.rotulo(dup)); return null; }
    const cid = id || 'cb-' + uid(), antes = id ? Repo.get('contasBancarias', id) : {};
    await Repo.salvar('contasBancarias', cid, { ...antes, ...d }, { modulo: 'fcx', rotulo: 'Conta ' + ContasBancarias.rotulo(d) });
    UI.toast('Conta salva'); return { id: cid, ...d };
  },
  abrirConta(id) {
    const c = id ? Repo.get('contasBancarias', id) : {};
    const acoes = [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => { if (!(await this.salvarConta(m, id))) return false; } }];
    if (id) acoes.unshift({ rotulo: 'Excluir', classe: 'danger', acao: async () => {
      const n = this.transacoes().filter(t => t.contaId === id).length;
      if (n) { UI.toast(`A conta tem ${n} transação(ões) importada(s). Desative-a em vez de excluir.`); return false; }
      if (!(await UI.confirmar('Excluir conta', `Excluir ${esc(ContasBancarias.rotulo(c))} do de-para?`, 'Excluir', true))) return false;
      await Repo.excluir('contasBancarias', id, { modulo: 'fcx', rotulo: 'Conta ' + ContasBancarias.rotulo(c) });
    } });
    UI.modal({ titulo: id ? 'Editar conta bancária' : 'Nova conta bancária', largo: true, corpo: this.formConta(c), acoes });
  },

  /* =====================================================================
     CONCILIAÇÃO BANCÁRIA · tela
     ===================================================================== */
  renderContas() {
    const contas = this.contas(), pode = Auth.can('fcx.dfc.contas');
    return `<div class="panel"><div class="row between"><div><h2>Contas bancárias (de-para OFX)</h2><p class="sub">Cada extrato OFX é vinculado a uma destas contas pelo banco, agência e conta (ou pelo identificador OFX).</p></div>${pode ? '<button class="btn sec" data-a="fd-bc-conta-nova">+ Nova conta</button>' : ''}</div>
      ${contas.length ? `<div class="tbl-wrap"><table><thead><tr><th>Conta</th><th>Banco</th><th>Agência</th><th>Conta</th><th>Tipo</th><th>Loja</th><th>ID no OFX</th><th>Última importação</th><th class="num">Último saldo</th>${pode ? '<th></th>' : ''}</tr></thead><tbody>
        ${contas.map(c => `<tr><td class="cell-main">${esc(c.apelido)}${c.ativa === false ? ' <span class="pill neutral">inativa</span>' : ''}</td><td>${esc(c.banco)} · ${esc(c.bancoNome || '')}</td><td class="mono">${esc(c.agencia || '—')}</td><td class="mono">${esc(c.conta)}${c.digito ? '-' + esc(c.digito) : ''}</td>
          <td>${esc(c.tipo || '')}</td><td>${esc(c.lojaId ? this.nomeLoja(c.lojaId) : 'Matriz')}</td><td class="mono">${esc(c.ofxAcctId || '—')}</td><td class="mono">${c.ultimaImportacao ? Fmt.dataHora(c.ultimaImportacao) : '—'}</td>
          <td class="num">${c.ultimoSaldo ? Fmt.brl(c.ultimoSaldo.valor) : '—'}</td>${pode ? `<td class="acts"><button class="iconbtn" data-a="fd-bc-conta-editar" data-id="${c.id}" aria-label="Editar">${ICON.editar}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`
        : `<div class="empty">Nenhuma conta cadastrada. Cadastre as contas ou importe um OFX: o painel oferece o cadastro com os dados do arquivo.</div>`}</div>`;
  },
  renderRegras() {
    const regras = DFC.regras(), pode = Auth.can('fcx.dfc.regras');
    const sent = { E: 'Entrada', S: 'Saída', '*': 'Ambos' };
    return `<div class="panel"><div class="row between"><div><h2>Regras de classificação da DFC</h2><p class="sub">A primeira regra cujo termo aparecer no histórico da transação define a categoria. Classificações manuais sempre prevalecem.</p></div>
        ${pode ? '<div class="row"><button class="btn ghost" data-a="fd-dfc-reaplicar">Recalcular DFC</button><button class="btn sec" data-a="fd-regra-nova">+ Nova regra</button></div>' : ''}</div>
      <div class="tbl-wrap"><table><thead><tr><th>Ordem</th><th>Termos no histórico</th><th>Sentido</th><th>Categoria DFC</th><th>Grupo</th>${pode ? '<th></th>' : ''}</tr></thead><tbody>
      ${regras.map((r, i) => { const c = DFC.cat(r.categoria) || {}; return `<tr><td class="mono">${i + 1}</td><td>${(r.termos || []).map(t => `<span class="pill neutral" style="margin:1px">${esc(t)}</span>`).join(' ')}</td><td>${sent[r.sentido] || r.sentido}</td><td>${esc(c.nome || r.categoria)}</td><td class="cell-sub">${esc((DFC_GRUPOS[c.grupo] || '').split(' (')[0])}</td>
        ${pode ? `<td class="acts"><button class="iconbtn" data-a="fd-regra-sobe" data-i="${i}" aria-label="Subir prioridade" ${i ? '' : 'disabled'}>↑</button><button class="iconbtn" data-a="fd-regra-editar" data-i="${i}" aria-label="Editar">${ICON.editar}</button><button class="iconbtn" data-a="fd-regra-del" data-i="${i}" aria-label="Excluir">${ICON.lixo}</button></td>` : ''}</tr>`; }).join('')}
      </tbody></table></div></div>`;
  },
  async salvarRegras(regras, detalhe) {
    await Repo.salvar('config', 'dfc', { ...(Repo.get('config', 'dfc') || {}), regras }, { modulo: 'fcx', rotulo: 'Regras DFC', detalhe });
  },
  abrirRegra(i) {
    const regras = DFC.regras().slice(), r = i != null ? regras[i] : { termos: [], sentido: 'S', categoria: 'pag_outros' };
    UI.modal({
      titulo: i != null ? 'Editar regra' : 'Nova regra de classificação',
      corpo: `<div class="form-grid">${campo('Termos (separados por vírgula)', 'termos', (r.termos || []).join(', '), { full: true, dica: 'Sem diferenciar maiúsculas e acentos. Ex.: NEOENERGIA, ENERGISA' })}
        ${campo('Sentido', 'sentido', r.sentido, { opcoes: [['E', 'Entrada'], ['S', 'Saída'], ['*', 'Ambos']] })}
        ${campo('Categoria DFC', 'categoria', r.categoria, { opcoes: DFC_CATEGORIAS.map(c => [c.id, `${c.nome} (${c.grupo.toLowerCase()})`]) })}</div>`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => {
        const d = UI.lerForm(m); const nova = { id: r.id || 'r-' + uid(), termos: d.termos.split(',').map(x => x.trim()).filter(Boolean), sentido: d.sentido, categoria: d.categoria };
        if (!nova.termos.length) { UI.toast('Informe ao menos um termo.'); return false; }
        if (i != null) regras[i] = nova; else regras.unshift(nova);
        await this.salvarRegras(regras, i != null ? 'Regra editada' : 'Regra criada'); await this.atualizarBaseDFC(this.mesesBanco());
      } }],
    });
  },
  renderExtratos() {
    const u = this.ui, meses = this.mesesBanco(), contas = this.contas();
    if (!meses.length) return `<div class="panel"><div class="empty">Nenhum extrato importado. Use “Importar OFX” (aceita vários arquivos de uma vez).${contas.length ? '' : ' Se a conta ainda não estiver no de-para, o painel oferece o cadastro com os dados do arquivo.'}</div></div>`;
    if (!meses.includes(u.mes)) return `<div class="panel"><div class="empty">Nenhum extrato importado para ${this.mesLabel(u.mes)}. Meses com extrato: ${meses.slice(0, 6).map(m => this.mesLabel(m)).join(', ')}.</div></div>`;
    const regras = DFC.regras();
    const todas = this.transacoes().filter(t => t.data.startsWith(u.mes) && (!u.conta || t.contaId === u.conta)).map(t => ({ ...t, cls: DFC.classificar(t, regras) }));
    const q = this.norm(u.busca);
    const lista = todas.filter(t => (u.filtro === 'todas' || (u.filtro === 'sem' && t.cls.origem === 'padrão') || (u.filtro === 'e' && t.valor > 0) || (u.filtro === 's' && t.valor < 0)) && (!q || this.norm(t.hist).includes(q)))
      .sort((a, b) => b.data.localeCompare(a.data) || Math.abs(b.valor) - Math.abs(a.valor));
    const c = DFC.consolidar(todas, regras), podeCls = Auth.can('fcx.dfc.importar');
    const saldos = contas.filter(k => !u.conta || k.id === u.conta).map(k => ({ k, s: this.docsDaConta(k.id, u.mes)[0]?.saldo })).filter(x => x.s);
    const optCat = sel => DFC_CATEGORIAS.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.nome)}</option>`).join('');
    return `<div class="toolbar">
        <div class="field"><label class="lbl" for="bcConta">Conta</label><select id="bcConta" data-a="fd-bc" data-k="conta"><option value="">Todas</option>${contas.map(k => `<option value="${k.id}" ${k.id === u.conta ? 'selected' : ''}>${esc(ContasBancarias.rotulo(k))}</option>`).join('')}</select></div>
        <div class="field grow"><label class="lbl" for="bcBusca">Buscar no histórico</label><input id="bcBusca" type="search" value="${esc(u.busca)}" data-a="fd-bc-busca" placeholder="Ex.: GETNET, ALUGUEL"></div></div>
      <div class="grid g4" style="margin-bottom:16px">
        <div class="kpi"><div class="k">Entradas</div><div class="v mono" style="color:var(--ok)">${Fmt.brl0(c.entradas)}</div><div class="d">sem transferências internas</div></div>
        <div class="kpi"><div class="k">Saídas</div><div class="v mono" style="color:var(--bad)">${Fmt.brl0(c.saidas)}</div><div class="d">${c.n} transações no mês</div></div>
        <div class="kpi"><div class="k">Saldo final (extrato)</div><div class="v mono">${saldos.length ? Fmt.brl0(saldos.reduce((a, x) => a + x.s.valor, 0)) : '—'}</div><div class="d">${saldos.length ? saldos.map(x => `${esc(x.k.apelido)} em ${Fmt.data(x.s.data)}`).join(' · ') : 'OFX sem saldo (LEDGERBAL)'}</div></div>
        <div class="kpi"><div class="k">Sem regra de classificação</div><div class="v" style="color:var(${c.semRegra ? '--warn' : '--ok'})">${c.semRegra}</div><div class="d">${c.semRegra ? 'caíram em “outras” — revise' : 'todas classificadas'}</div></div></div>
      <div class="panel"><div class="row between" style="margin-bottom:10px"><h2>Transações</h2>
        <div class="seg">${[['todas', 'Todas'], ['e', 'Entradas'], ['s', 'Saídas'], ['sem', `Sem regra (${c.semRegra})`]].map(([k, r]) => `<button class="${u.filtro === k ? 'on' : ''}" data-a="fd-bc-filtro" data-v="${k}">${r}</button>`).join('')}</div></div>
      ${lista.length ? `<div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Conta</th><th>Histórico</th><th class="num">Valor</th><th>Categoria DFC</th></tr></thead><tbody>
        ${lista.slice(0, u.limite).map(t => `<tr><td class="mono">${Fmt.data(t.data)}</td><td class="cell-sub">${esc(Repo.get('contasBancarias', t.contaId)?.apelido || '—')}</td><td>${esc(t.hist)}${t.doc ? `<div class="cell-sub mono">doc ${esc(t.doc)}</div>` : ''}</td>
          <td class="num"><b style="color:var(${t.valor >= 0 ? '--ok' : '--bad'})">${Fmt.brl(t.valor)}</b></td>
          <td>${podeCls ? `<select data-a="fd-bc-cat" data-doc="${t.docId}" data-id="${esc(t.id)}" aria-label="Categoria DFC" style="min-width:210px">${optCat(t.cls.categoria)}</select>` : esc(DFC.cat(t.cls.categoria)?.nome)}
            <div class="cell-sub">${t.cls.origem === 'manual' ? 'classificação manual' : t.cls.origem === 'regra' ? 'por regra' : '<span style="color:var(--warn)">sem regra</span>'}</div></td></tr>`).join('')}
      </tbody></table></div>${lista.length > u.limite ? `<button class="btn sec sm" style="margin-top:10px" data-a="fd-bc-mais">Mostrar mais (${lista.length - u.limite})</button>` : ''}` : '<div class="empty">Nenhuma transação com esse filtro.</div>'}</div>`;
  },
  async classificarManual(docId, id, cat) {
    const doc = Repo.get('extratos', docId);
    await Repo.salvar('extratos', docId, { ...doc, transacoes: doc.transacoes.map(t => t.id === id ? { ...t, cat } : t) }, { modulo: 'fcx', rotulo: 'Classificação DFC', detalhe: `${id} → ${DFC.cat(cat)?.nome}` });
    await this.atualizarBaseDFC([doc.mes]);
  },

  /* =====================================================================
     DFC — Demonstração dos Fluxos de Caixa (método direto)
     ===================================================================== */
  renderDFC() {
    if (!Auth.can('fcx.dfc.ver')) return this.bloqueado('DFC', 'A Demonstração dos Fluxos de Caixa é restrita ao perfil GESTOR.');
    if (!Repo.prontas.has('extratos')) return '<div class="panel"><p class="muted">Carregando…</p></div>';
    const u = this.ui, meses = this.mesesBanco();
    this._dfcDados = null;
    if (!meses.includes(u.mes)) return `<div class="panel"><div class="empty">A DFC é montada automaticamente a partir dos extratos OFX e ainda não há extrato de ${this.mesLabel(u.mes)}. Use “Importar OFX”.</div></div>`;
    const tr = this.transacoes().filter(t => t.data.startsWith(u.mes) && (!u.conta || t.contaId === u.conta));
    const c = DFC.consolidar(tr), base = Repo.get('dfc', u.mes);
    const dias = Object.entries(c.porDia).sort((a, b) => a[0].localeCompare(b[0]));
    this._dfcDados = { dias };
    const linhas = g => DFC_CATEGORIAS.filter(x => x.grupo === g && c.porCategoria[x.id]).map(x => `<tr><td style="padding-left:26px">${esc(x.nome)} <span class="hint">(${c.porCategoria[x.id].n})</span></td><td class="num" style="color:var(${c.porCategoria[x.id].valor >= 0 ? '--ok' : '--bad'})">${Fmt.brl(c.porCategoria[x.id].valor)}</td></tr>`).join('');
    const grupo = g => `<tr class="grp"><td><b>${esc(DFC_GRUPOS[g].split(' (')[0])}</b></td><td class="num"><b>${Fmt.brl(c.porGrupo[g].liquido)}</b></td></tr>${linhas(g)}`;
    const op = c.porGrupo.OPERACIONAL, contas = this.contas();
    return `<div class="toolbar">
        <div class="field"><label class="lbl" for="dfcConta">Conta</label><select id="dfcConta" data-a="fd-dfc" data-k="conta"><option value="">Consolidado</option>${contas.map(k => `<option value="${k.id}" ${k.id === u.conta ? 'selected' : ''}>${esc(ContasBancarias.rotulo(k))}</option>`).join('')}</select></div></div>
      <div class="grid g4" style="margin-bottom:16px">
        <div class="kpi"><div class="k">Entradas operacionais</div><div class="v mono" style="color:var(--ok)">${Fmt.brl0(op.entradas)}</div></div>
        <div class="kpi"><div class="k">Saídas operacionais</div><div class="v mono" style="color:var(--bad)">${Fmt.brl0(op.saidas)}</div></div>
        <div class="kpi"><div class="k">Geração de caixa operacional</div><div class="v mono" style="color:var(${op.liquido >= 0 ? '--ok' : '--bad'})">${Fmt.brl0(op.liquido)}</div><div class="d">${op.entradas ? Fmt.pct(op.liquido / op.entradas * 100, 1) + ' das entradas' : ''}</div></div>
        <div class="kpi"><div class="k">Variação líquida de caixa</div><div class="v mono">${Fmt.brl0(c.liquido)}</div><div class="d">operacional + investimento + financiamento</div></div></div>
      <div class="grid g2 cs-top">
        <div class="panel"><h2>Demonstração dos Fluxos de Caixa · ${this.mesLabel(u.mes)}</h2><p class="sub">Método direto, a partir das transações bancárias${u.conta ? ' da conta selecionada' : ' de todas as contas'}.</p>
          <div class="tbl-wrap"><table class="nolabel dfc"><tbody>${grupo('OPERACIONAL')}${grupo('INVESTIMENTO')}${grupo('FINANCIAMENTO')}
            <tr class="tot"><td><b>Variação líquida de caixa</b></td><td class="num"><b>${Fmt.brl(c.liquido)}</b></td></tr>
            ${c.transferencias ? `<tr><td class="hint">Transferências entre contas próprias (fora do total)</td><td class="num hint">${Fmt.brl(c.transferencias)}</td></tr>` : ''}</tbody></table></div></div>
        <div class="stack"><div class="panel"><h2>Entradas e saídas por dia</h2><p class="sub">Sem transferências internas.</p><div class="chart-box"><canvas id="dfcDia" role="img" aria-label="Entradas e saídas por dia"></canvas></div></div>
          <div class="panel"><h2>Base de KPIs da DFC</h2><p class="sub" style="margin-bottom:6px">Cada importação ou reclassificação regrava o resumo do mês em <span class="mono">dfc/${u.mes}</span>, usado no Realizado × Previsto com as premissas do FCX.</p>
            <p class="hint" style="margin:0">${base ? `Última atualização: ${Fmt.dataHora(base.atualizadoEm)} · ${base.transacoes} transações` : 'Ainda não gravada.'}</p></div></div></div>`;
  },
  graficosDFC({ dias }) {
    const ok = this.cor('--ok'), bad = this.cor('--bad'), grid = this.cor('--line-soft'), ink = this.cor('--ink-soft');
    this.grafico('dfcDia', { type: 'bar', data: { labels: dias.map(([d]) => Fmt.data(d).slice(0, 5)), datasets: [
      { label: 'Entradas', data: dias.map(([, v]) => this.r2(v.entradas)), backgroundColor: ok, borderRadius: 4, maxBarThickness: 18 },
      { label: 'Saídas', data: dias.map(([, v]) => this.r2(v.saidas)), backgroundColor: bad, borderRadius: 4, maxBarThickness: 18 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: ink, boxWidth: 10 } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${Fmt.brl(c.parsed.y)}` } } },
        scales: { x: { grid: { display: false }, ticks: { color: ink } }, y: { grid: { color: grid }, ticks: { color: ink, callback: v => Fmt.brl0(v) } } } } });
  },

  /* =====================================================================
     TELA
     ===================================================================== */
  meses() {
    const atual = this.mesAtual(), base = new Set([atual, ...this.mesesBanco()]);
    for (let i = -3; i <= 3; i++) { const [y, m] = atual.split('-').map(Number); const d = new Date(y, m - 1 + i, 1); base.add(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); }
    return [...base].sort().reverse();
  },
  render() {
    if (!Auth.can('fcx.dfc.ver')) return this.bloqueado('DFC', 'Extratos bancários, a DFC e o cruzamento com o FCX são restritos ao perfil GESTOR.');
    if (!['extratos', 'contasBancarias'].every(c => Repo.prontas.has(c))) return '<div class="panel"><p class="muted">Carregando extratos…</p></div>';
    const u = this.ui; if (!u.mes) u.mes = this.mesAtual();
    const subs = [['cruzamento', 'Realizado × Previsto'], ['dfc', 'DFC do mês'], ['extratos', 'Extratos OFX'], ['contas', `Contas bancárias (${this.contas().length})`], ['regras', 'Regras de classificação']];
    const comMes = ['cruzamento', 'dfc', 'extratos'].includes(u.sub);
    const topo = `<div class="row between" style="margin-bottom:14px;align-items:flex-end;gap:12px">
        <div class="seg" role="tablist" aria-label="Seções da DFC">${subs.map(([k, r]) => `<button class="${u.sub === k ? 'on' : ''}" data-a="fd-sub" data-v="${k}">${r}</button>`).join('')}</div>
        ${Auth.can('fcx.dfc.importar') ? `<label class="btn" style="cursor:pointer">Importar OFX<input type="file" accept=".ofx,.OFX,application/x-ofx" multiple hidden data-a="fd-bc-upload"></label>` : ''}</div>
      ${comMes ? `<div class="row between" style="margin-bottom:14px;align-items:flex-end"><div class="toolbar" style="margin:0;flex:1"><div class="field" style="max-width:260px"><label class="lbl" for="fdMes">Mês</label>
        <select id="fdMes" data-a="fd-f" data-k="mes">${this.meses().map(m => `<option value="${m}" ${m === u.mes ? 'selected' : ''}>${this.mesLabel(m)}${m === this.mesAtual() ? ' (atual)' : ''}${this.mesesBanco().includes(m) ? '' : ' · sem OFX'}</option>`).join('')}</select></div></div>
        ${u.sub === 'cruzamento' ? `<div class="row">${Auth.can('fcx.dfc.regras') ? '<button class="btn ghost" data-a="fd-mapa">De-para FCX → DFC</button>' : ''}${Auth.can('fcx.dfc.contas') ? '<button class="btn sec" data-a="fd-saldo">Saldo inicial do mês</button>' : ''}</div>` : ''}</div>` : ''}`;
    this._czDados = null; this._dfcDados = null;
    const corpo = { cruzamento: () => this.renderCruzamento(), dfc: () => this.renderDFC(), extratos: () => this.renderExtratos(), contas: () => this.renderContas(), regras: () => this.renderRegras() }[u.sub] || (() => this.renderCruzamento());
    return topo + corpo();
  },
  afterRender() {
    if (this.ui.sub === 'cruzamento' && this._czDados) this.graficosCruzamento(this._czDados);
    if (this.ui.sub === 'dfc' && this._dfcDados) this.graficosDFC(this._dfcDados);
  },

  /* ---------------- Realizado × Previsto ---------------- */
  renderCruzamento() {
    const u = this.ui;
    if (!FCX.api()) { FCX.montar(); return `<div class="panel"><p class="muted" style="margin:0">Lendo as premissas do FCX (projeção de vendas, prestação e saídas)…</p></div>`; }
    const c = Cruzamento.calcular(u.mes); this._czDados = c;
    const pct = v => v == null ? '—' : Fmt.pct(v * 100, 1);
    const avisos = (c.semRealizado ? `<div class="note warn" style="margin-bottom:12px">Nenhuma transação bancária em ${this.mesLabel(u.mes)}: use “Importar OFX” para trazer o realizado.</div>` : '')
      + (c.semPrevisto ? `<div class="note warn" style="margin-bottom:12px">O FCX não tem premissas para ${this.mesLabel(u.mes)} (meta, pesos e meios de pagamento ou saídas). Preencha em “FCX · Fluxo de Caixa → Gerenciar dados”.</div>` : '');
    const vd = c.despesas.variancia;
    const kpis = `<div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Receitas · realizado × previsto</div><div class="v">${pct(c.receitas.taxa)}</div><div class="d">taxa de realização · ${Fmt.brl0(c.receitas.realizado)} de ${Fmt.brl0(c.receitas.previsto)}</div></div>
      <div class="kpi"><div class="k">Despesas · realizado × previsto</div><div class="v mono" style="color:var(${vd > 0 ? '--bad' : '--ok'})">${vd > 0 ? '+' : ''}${Fmt.brl0(vd)}</div><div class="d">variância · ${Fmt.brl0(c.despesas.realizado)} pagos de ${Fmt.brl0(c.despesas.previsto)} previstos</div></div>
      <div class="kpi"><div class="k">Atrasos · saídas vencidas</div><div class="v mono" style="color:var(${c.atrasos.total ? '--bad' : '--ok'})">${Fmt.brl0(c.atrasos.total)}</div><div class="d">${c.atrasos.n} lançamento(s) do mês vencido(s) e não marcado(s) como Pago no FCX${c.atrasos.nAnterior ? ` · +${Fmt.brl0(c.atrasos.estoqueAnterior)} de meses anteriores` : ''}</div></div>
      <div class="kpi"><div class="k">Projeção de fechamento</div><div class="v mono" style="color:var(${c.saldoFinalPrevisto >= 0 ? '--ink' : '--bad'})">${Fmt.brl0(c.saldoFinalPrevisto)}</div><div class="d">${c.encerrado ? 'mês encerrado: saldo inicial + realizado' : c.futuro ? `saldo inicial ${Fmt.brl0(c.saldo.valor)} + previsto do FCX ${Fmt.brl0(c.previstoMes)}` : `saldo inicial ${Fmt.brl0(c.saldo.valor)} + realizado ${Fmt.brl0(c.dfc.liquido)} + previsto a partir de hoje ${Fmt.brl0(c.previstoRestante)} − vencidos ${Fmt.brl0(c.atrasos.total)}`}</div></div></div>`;
    const grafico = `<div class="panel"><h2>Saldo de caixa no mês</h2><p class="sub">Azul: realizado pelos extratos. Laranja tracejado: projeção a partir de hoje com as premissas do FCX (vencidos entram hoje). Cinza: o que o FCX previa para o mês inteiro. Saldo inicial ${esc(c.saldo.origem)}.</p>
      <div class="chart-box"><canvas id="czSaldo" role="img" aria-label="Saldo realizado, projetado e previsto no mês"></canvas></div></div>`;
    const grupos = ['OPERACIONAL', 'INVESTIMENTO', 'FINANCIAMENTO'];
    const comp = l => l.itens.length ? `<details class="log"><summary>composição no FCX (${l.itens.length})</summary>${l.itens.slice(0, 12).map(([k, v]) => `<div class="chg">${esc(k)}: <b>${Fmt.brl(v)}</b></div>`).join('')}${l.itens.length > 12 ? `<div class="chg">… e mais ${l.itens.length - 12}</div>` : ''}</details>` : '';
    const linha = l => `<tr><td style="padding-left:24px">${esc(l.nome)} <span class="hint">(${l.sentido === 'E' ? 'entrada' : 'saída'})</span>${comp(l)}</td>
      <td class="num">${Fmt.brl(l.previsto)}</td><td class="num">${Fmt.brl(l.realizado)}${l.nReal ? `<div class="cell-sub">${l.nReal} lançamento(s)</div>` : ''}</td>
      <td class="num"><b style="color:var(${l.dif === 0 ? '--ink-soft' : l.favoravel ? '--ok' : '--bad'})">${l.dif > 0 ? '+' : ''}${Fmt.brl(l.dif)}</b></td><td class="num">${pct(l.pct)}</td>
      <td>${!l.previsto ? '<span class="pill neutral">sem previsão</span>' : !l.realizado ? '<span class="pill warn">não realizado</span>' : `<span class="pill ${l.favoravel ? 'ok' : 'bad'}">${l.favoravel ? 'favorável' : 'desfavorável'}</span>`}</td></tr>`;
    const tot = arr => ({ p: arr.reduce((a, l) => a + (l.sentido === 'E' ? 1 : -1) * l.previsto, 0), r: arr.reduce((a, l) => a + (l.sentido === 'E' ? 1 : -1) * l.realizado, 0) });
    const tabela = `<div class="panel"><h2>Categoria a categoria · ${this.mesLabel(u.mes)}</h2><p class="sub">Previsto = premissas do FCX no mês (vendas líquidas por meio de pagamento na data de recebimento, prestação e saídas por conta contábil). Realizado = transações do OFX classificadas na mesma categoria. Diferença = realizado − previsto (em receitas, positivo é favorável; em despesas, negativo é favorável).</p>
      ${c.linhas.length ? `<div class="tbl-wrap"><table class="cz"><thead><tr><th>Categoria</th><th class="num">Previsto (FCX)</th><th class="num">Realizado (DFC)</th><th class="num">Diferença</th><th class="num">Realização</th><th>Leitura</th></tr></thead><tbody>
      ${grupos.map(g => { const ls = c.linhas.filter(l => l.grupo === g); if (!ls.length) return ''; const t = tot(ls);
        return `<tr class="grp"><td class="span-all" colspan="6"><b>${esc(DFC_GRUPOS[g].split(' (')[0])}</b> <span class="hint">· líquido previsto ${Fmt.brl(t.p)} · realizado ${Fmt.brl(t.r)}</span></td></tr>${ls.map(linha).join('')}`; }).join('')}
      </tbody></table></div>` : '<div class="empty">Sem previsto nem realizado no mês.</div>'}</div>`;
    return avisos + kpis + grafico + tabela;
  },
  graficosCruzamento(c) {
    const ink = this.cor('--ink-soft'), grid = this.cor('--line-soft'), real = this.cor('--accent'), proj = this.cor('--warn'), plano = this.cor('--ink-faint');
    this.grafico('czSaldo', { type: 'line', data: { labels: c.dias.map(d => d.iso.slice(8)), datasets: [
      { label: 'Realizado (OFX)', data: c.dias.map(d => d.real), borderColor: real, backgroundColor: real, borderWidth: 2.2, pointRadius: 0, tension: 0.2, spanGaps: false },
      { label: 'Projetado', data: c.dias.map(d => d.proj), borderColor: proj, backgroundColor: proj, borderWidth: 2, borderDash: [6, 4], pointRadius: 0, tension: 0.2, spanGaps: true },
      { label: 'Previsto no FCX', data: c.dias.map(d => d.plano), borderColor: plano, backgroundColor: plano, borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, tension: 0.2 }] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { color: ink, boxWidth: 12 } }, tooltip: { callbacks: { title: it => `${it[0].label}/${c.mes.slice(5)}`, label: x => x.parsed.y == null ? null : ` ${x.dataset.label}: ${Fmt.brl(x.parsed.y)}` } } },
        scales: { x: { grid: { display: false }, ticks: { color: ink, maxTicksLimit: 16 } }, y: { grid: { color: grid }, ticks: { color: ink, callback: v => Fmt.brl0(v) } } } } });
  },
  abrirSaldoInicial() {
    const mes = this.ui.mes, cfg = Repo.get('config', 'fcx_saldos') || { saldosIniciais: {} }, auto = Cruzamento.saldoInicial(mes);
    UI.modal({
      titulo: 'Saldo inicial · ' + this.mesLabel(mes),
      corpo: `<p class="hint" style="margin-top:0">Hoje: ${Fmt.brl(auto.valor)} (${esc(auto.origem)}). Informe um valor para substituir, ou deixe em branco para usar o saldo dos extratos do mês anterior.</p>${campo('Saldo inicial consolidado (R$)', 'valor', cfg.saldosIniciais?.[mes] ?? '', { tipo: 'number' })}`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => {
        const v = UI.lerForm(m).valor, s = { ...(cfg.saldosIniciais || {}) }; if (v == null || v === '') delete s[mes]; else s[mes] = v;
        await Repo.salvar('config', 'fcx_saldos', { saldosIniciais: s }, { modulo: 'fcx', rotulo: 'Saldo inicial ' + this.mesLabel(mes) });
      } }],
    });
  },
  /** De-para conta contábil do FCX → categoria da DFC (só as contas com lançamento no mês escolhido). */
  abrirMapa() {
    const c = this._czDados, contas = c?.contasFCX || [], mapa = PrevistoFCX.mapa();
    if (!contas.length) return UI.toast('Nenhuma saída do FCX neste mês.');
    const opt = (sel) => DFC_CATEGORIAS.filter(x => x.sentido !== 'E' && x.grupo !== 'TRANSFERENCIA').map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.nome)}</option>`).join('');
    UI.modal({
      titulo: 'De-para FCX → DFC · ' + this.mesLabel(this.ui.mes), largo: true,
      corpo: `<p class="hint" style="margin-top:0">A categoria padrão vem do código da conta contábil. Altere só as que precisar: a escolha vale para todos os meses.</p>
        <div class="tbl-wrap"><table class="nolabel"><thead><tr><th>Conta contábil (FCX)</th><th>Categoria DFC</th></tr></thead><tbody>
        ${contas.map((k, i) => `<tr><td>${esc(k)}${mapa[k] ? ' <span class="pill info">ajustada</span>' : ''}</td><td><select name="c${i}" data-conta="${esc(k)}" aria-label="Categoria de ${esc(k)}">${opt(PrevistoFCX.categoriaDaConta(k, mapa))}</select></td></tr>`).join('')}</tbody></table></div>`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar de-para', acao: async m => {
        const novo = { ...mapa };
        $$('select[data-conta]', m).forEach(s => { const k = s.dataset.conta; if (s.value === PrevistoFCX.categoriaPadrao(k)) delete novo[k]; else novo[k] = s.value; });
        await Repo.salvar('config', 'dfc', { ...(Repo.get('config', 'dfc') || {}), mapaFCX: novo }, { modulo: 'fcx', rotulo: 'De-para FCX → DFC' });
        UI.toast('De-para salvo');
      } }],
    });
  },

  /* ---------------- eventos (prefixo fd-) ---------------- */
  async acao(a, el) {
    const u = this.ui;
    switch (a) {
      case 'fd-sub': u.sub = el.dataset.v; return App.render();
      case 'fd-saldo': return this.abrirSaldoInicial();
      case 'fd-mapa': return this.abrirMapa();
      case 'fd-bc-filtro': u.filtro = el.dataset.v; u.limite = 200; return App.render();
      case 'fd-bc-mais': u.limite += 400; return App.render();
      case 'fd-bc-conta-nova': return this.abrirConta(null);
      case 'fd-bc-conta-editar': return this.abrirConta(el.dataset.id);
      case 'fd-regra-nova': return this.abrirRegra(null);
      case 'fd-regra-editar': return this.abrirRegra(+el.dataset.i);
      case 'fd-regra-del': { const r = DFC.regras().slice(); if (!(await UI.confirmar('Excluir regra', `Excluir a regra “${esc((r[+el.dataset.i].termos || []).join(', '))}”?`, 'Excluir', true))) return; r.splice(+el.dataset.i, 1); await this.salvarRegras(r, 'Regra excluída'); return this.atualizarBaseDFC(this.mesesBanco()); }
      case 'fd-regra-sobe': { const r = DFC.regras().slice(), i = +el.dataset.i; [r[i - 1], r[i]] = [r[i], r[i - 1]]; await this.salvarRegras(r, 'Prioridade alterada'); return this.atualizarBaseDFC(this.mesesBanco()); }
      case 'fd-dfc-reaplicar': UI.toast('Recalculando…'); await this.atualizarBaseDFC(this.mesesBanco()); return UI.toast('DFC recalculada');
    }
  },
  async mudanca(a, el) {
    if (a === 'fd-f') { this.ui[el.dataset.k] = el.value; this.ui.limite = 200; return App.render(); }
    if (a === 'fd-bc' || a === 'fd-dfc') { this.ui[el.dataset.k] = el.value; this.ui.limite = 200; return App.render(); }
    if (a === 'fd-bc-cat') return this.classificarManual(el.dataset.doc, el.dataset.id, el.value);
    if (a === 'fd-bc-upload') {
      const fs = [...el.files]; el.value = ''; if (!fs.length) return;
      try { await this.importarOFX(fs); App.render(); } catch (e) { UI.toast('Falha ao ler o OFX: ' + e.message); }
    }
  },
  entrada(a, el) { if (a === 'fd-bc-busca') { this.ui.busca = el.value; App.render(); } },
};
