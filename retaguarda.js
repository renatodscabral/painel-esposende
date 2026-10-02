/* =====================================================================
   MÓDULO 4 — RETAGUARDA FINANCEIRA
   Abas:
     1. Conciliação Credsystem — Websystem × sistema interno (dinheiro, PIX, cartão)
     2. Faltas de Caixa       — lançamentos, base de caixas, ranking de quebras
     3. IEO · Ranking         — pontuação, pódio, alertas, laudos e WhatsApp → retaguarda-fin.js
   (Conciliação bancária/OFX e DFC ficam no Módulo 3 — FCX, aba "DFC": fcx-dfc.js)
   Coleções (agrupadas para respeitar o limite de documentos do banco):
     credsystem/<AAAA-MM-DD>        { data, linhas:[{chave,lojaId,texto,web,din,cart,pix,obs}] , arquivos[] }
     faltas/<AAAA-MM>_<loja-XXX>    { mes, lojaId, itens:[{id,data,tipo,valor,caixa{tipo,id,nome,matricula},justificativa,status,origem}] }
     caixas/<loja-XXX>              { lojaId, operadores:[{id,nome,matricula,ativo}] }
   ===================================================================== */
const RETAGUARDA_CFG = {
  toleranciaCredsystem: 0.05,       // |diferença| até R$ 0,05 = conciliado (arredondamentos)
  reincidenciaFaltas: 3,            // nº de ocorrências no período para marcar o caixa como reincidente
  statusFalta: ['Em análise', 'Justificada', 'Descontada em folha', 'Abonada'],
  // cores categóricas fixas (paleta validada) — dinheiro, PIX, cartão
  corModalidade: { din: '#2a78d6', pix: '#1baf7a', cart: '#eb6834' },
};

const Retaguarda = {
  ui: {
    aba: 'credsystem',
    cs: { mes: '', loja: '', filtro: 'div', busca: '', limite: 150, verTodasLojas: false },
    ft: { periodo: '', loja: '', status: '', busca: '', verTodos: false },
  },
  _charts: {},
  colecoes() { return ['credsystem', 'faltas', 'caixas', 'lojas', 'funcionarios']; },

  /* ======================= utilitários ======================= */
  norm: s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(),
  num(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).replace(/[R$\s]/g, ''); if (!s || s === '-') return null;
    const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return isNaN(n) ? null : n;
  },
  dataISO(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 864e5)); return d.toISOString().slice(0, 10); } // serial do Excel
    if (v instanceof Date) return Datas.iso(v);
    const s = String(v).trim(); let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : null;
  },
  /** "30 -PALMARES", "09- MIX CASA FORTE" → loja-030 / loja-009 (pelo número da filial). */
  loja(texto) {
    const m = String(texto ?? '').match(/^\s*(\d{1,3})/); const cod = m ? m[1].padStart(3, '0') : null;
    const l = cod ? Repo.get('lojas', 'loja-' + cod) : null;
    return { lojaId: l ? l.id : null, codigo: cod, nome: l ? l.nome : String(texto ?? '').trim(), texto: String(texto ?? '').trim() };
  },
  nomeLoja(id, texto) { const l = id && Repo.get('lojas', id); return l ? `${l.codigo} · ${l.nome}` : (texto || '—'); },
  r2: n => Math.round((n + Number.EPSILON) * 100) / 100,
  mesLabel: mk => { const [y, m] = mk.split('-'); return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][+m - 1] + '/' + y; },
  /** Lê a primeira aba com cabeçalho reconhecível e devolve linhas como objetos por coluna-alvo. */
  async lerPlanilha(file, mapa) {
    const XLSX = await Libs.xlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    for (const nome of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: null });
      for (let h = 0; h < Math.min(rows.length, 15); h++) {
        const cab = (rows[h] || []).map(c => this.norm(c));
        const idx = {};
        for (const [alvo, nomes] of Object.entries(mapa)) idx[alvo] = cab.findIndex(c => nomes.some(n => c === n || c.startsWith(n)));
        const obrig = Object.entries(mapa).filter(([k]) => !k.startsWith('_opt')).map(([k]) => k);
        if (['loja', 'data'].every(k => !(k in idx) || idx[k] >= 0) && idx.loja >= 0) {
          return { aba: nome, linhas: rows.slice(h + 1).filter(r => r && r.some(c => c != null && c !== '')).map(r => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i >= 0 ? r[i] : null]))), colunas: idx, obrig };
        }
      }
    }
    throw new Error('Não encontrei o cabeçalho (colunas LOJA e DATA) em nenhuma aba.');
  },
  async grafico(id, config) {
    const Chart = await Libs.chart(); const cv = document.getElementById(id); if (!cv) return;
    if (this._charts[id]) this._charts[id].destroy();
    this._charts[id] = new Chart(cv, config);
  },
  cor(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); },

  /* ======================= tela ======================= */
  render() {
    const abas = [['credsystem', 'Conciliação Credsystem'], ['faltas', 'Faltas de Caixa'], ['ieo', 'IEO · Ranking'], ['adquirentes', 'Auditoria de Adquirentes']];
    if (!abas.some(([k]) => k === this.ui.aba)) this.ui.aba = 'credsystem';
    const a = this.ui.aba;
    if (a !== 'adquirentes') this.liberarAdq?.(); // saiu da Auditoria de Adquirentes: solta os arquivos da memória
    const alertas = this.alertasAbertos ? this.alertasAbertos().length : 0;
    return `<div class="page-head"><div><h1>Retaguarda Financeira</h1><p>Operação das lojas: conciliação Credsystem, faltas de caixa e o Índice de Eficiência Operacional. Extratos bancários e DFC ficam no FCX (Módulo 4).</p></div></div>
      <div class="tabs" role="tablist">${abas.map(([k, r]) => `<button class="${a === k ? 'on' : ''}" data-a="rt-aba" data-v="${k}">${r}${k === 'ieo' && alertas ? ` <span class="pill bad" style="margin-left:4px">${alertas}</span>` : ''}</button>`).join('')}</div>
      ${({ credsystem: () => this.renderCS(), faltas: () => this.renderFT(), ieo: () => this.renderIEO(), adquirentes: () => this.renderAdq() })[a]()}`;
  },
  afterRender() {
    if (this.ui.aba === 'adquirentes') this.montarAdq();
    if (this.ui.aba === 'credsystem' && this._csDados) this.graficosCS(this._csDados);
    if (this.ui.aba === 'faltas' && this._ftDados) this.graficosFT(this._ftDados);
    if (this.ui.aba === 'ieo' && this._ieoDados) this.sincronizarAlertas(this._ieoDados.ranking, this._ieoDados.mes).catch(() => { });
  },

  /* =====================================================================
     1. CONCILIAÇÃO CREDSYSTEM
     ===================================================================== */
  statusLinha(l) {
    const temInterno = [l.din, l.cart, l.pix].some(v => v != null);
    const interno = this.r2((l.din || 0) + (l.cart || 0) + (l.pix || 0));
    const dif = this.r2((l.web || 0) - interno);
    if (!temInterno && (l.web || 0) > 0) return { interno, dif, st: 'pend' };
    return { interno, dif, st: Math.abs(dif) <= RETAGUARDA_CFG.toleranciaCredsystem ? 'ok' : 'div' };
  },
  linhasCS() {
    return Repo.todos('credsystem').flatMap(d => (d.linhas || []).map(l => ({ ...l, data: d.id, docId: d.id, ...this.statusLinha(l) })));
  },
  mesesCS() { return [...new Set(Repo.todos('credsystem').map(d => d.id.slice(0, 7)))].sort().reverse(); },

  renderCS() {
    if (!Repo.prontas.has('credsystem')) return '<div class="panel"><p class="muted">Carregando conciliações…</p></div>';
    const u = this.ui.cs, meses = this.mesesCS();
    if (!u.mes || (meses.length && !meses.includes(u.mes))) u.mes = meses[0] || Datas.hojeISO().slice(0, 7);
    const podeImp = Auth.can('retaguarda.credsystem.importar');
    const topo = `<div class="row between" style="margin-bottom:14px">
        <div class="toolbar" style="margin:0;flex:1">
          <div class="field"><label class="lbl" for="csMes">Mês</label><select id="csMes" data-a="rt-cs" data-k="mes">${(meses.length ? meses : [u.mes]).map(m => `<option value="${m}" ${m === u.mes ? 'selected' : ''}>${this.mesLabel(m)}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="csLoja">Loja</label><select id="csLoja" data-a="rt-cs" data-k="loja"><option value="">Todas</option>${Repo.todos('lojas').sort((a, b) => a.codigo.localeCompare(b.codigo)).map(l => `<option value="${l.id}" ${l.id === u.loja ? 'selected' : ''}>${l.codigo} · ${esc(l.nome)}</option>`).join('')}</select></div>
        </div>
        ${podeImp ? `<label class="btn" style="cursor:pointer">Importar relatório (.xlsx)<input type="file" accept=".xlsx,.xls,.csv" hidden data-a="rt-cs-upload"></label>` : ''}</div>`;
    const linhas = this.linhasCS().filter(l => l.data.startsWith(u.mes) && (!u.loja || l.lojaId === u.loja));
    this._csDados = null;
    if (!linhas.length) return topo + `<div class="panel"><div class="empty">Nenhuma conciliação em ${this.mesLabel(u.mes)}.${podeImp ? ' Importe o relatório do Websystem (colunas LOJA, DATA, WEBSYSTEM, DINHEIRO, CARTAO, PIX).' : ''}</div></div>`;

    /* ---- consolidação ---- */
    const soma = (arr, k) => this.r2(arr.reduce((a, l) => a + (l[k] || 0), 0));
    const lancadas = linhas.filter(l => l.st !== 'pend'), pend = linhas.filter(l => l.st === 'pend'), divs = linhas.filter(l => l.st === 'div');
    const web = soma(lancadas, 'web'), interno = soma(lancadas, 'interno'), difLiq = this.r2(web - interno), difAbs = this.r2(divs.reduce((a, l) => a + Math.abs(l.dif), 0));
    const din = soma(lancadas, 'din'), pix = soma(lancadas, 'pix'), cart = soma(lancadas, 'cart');
    const taxa = lancadas.length ? (lancadas.length - divs.length) / lancadas.length : 0;
    const porLoja = {};
    for (const l of linhas) {
      const k = l.lojaId || 'txt:' + l.texto, r = porLoja[k] ||= { chave: k, lojaId: l.lojaId, texto: l.texto, web: 0, n: 0, abs: 0, liq: 0, maior: 0, pend: 0 };
      r.web += l.web || 0; if (l.st === 'pend') r.pend++;
      if (l.st === 'div') { r.n++; r.abs += Math.abs(l.dif); r.liq += l.dif; if (Math.abs(l.dif) > Math.abs(r.maior)) r.maior = l.dif; }
    }
    const ranking = Object.values(porLoja).filter(r => r.n).sort((a, b) => b.abs - a.abs);
    const porDia = {}; linhas.forEach(l => { const d = porDia[l.data] ||= { data: l.data, dif: 0, web: 0, n: 0 }; if (l.st === 'div') { d.dif += l.dif; d.n++; } d.web += l.web || 0; });
    this._csDados = { dias: Object.values(porDia).sort((a, b) => a.data.localeCompare(b.data)) };

    const kpis = `<div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Recebido Websystem</div><div class="v mono">${Fmt.brl0(web)}</div><div class="d">${lancadas.length} loja-dias conferidos${pend.length ? ` · +${Fmt.brl0(soma(pend, 'web'))} aguardando lançamento` : ''}</div></div>
      <div class="kpi"><div class="k">Lançado no sistema interno</div><div class="v mono">${Fmt.brl0(interno)}</div><div class="d">diferença líquida <b style="color:var(${Math.abs(difLiq) > 0.05 ? '--bad' : '--ok'})">${Fmt.brl(difLiq)}</b></div></div>
      <div class="kpi"><div class="k">Taxa de conciliação</div><div class="v">${Fmt.pct(taxa * 100, 1)}</div><div class="d">${divs.length} divergência(s) · ${Fmt.brl(difAbs)} em valor absoluto</div></div>
      <div class="kpi"><div class="k">Pendentes de lançamento</div><div class="v" style="color:var(${pend.length ? '--warn' : '--ok'})">${pend.length}</div><div class="d">${pend.length ? 'loja-dias só com Websystem' : 'tudo lançado'}</div></div></div>`;
    const tot = din + pix + cart || 1;
    const mix = `<div class="panel"><div class="row between"><h2>Recebimento por modalidade</h2><span class="hint">sistema interno · ${this.mesLabel(u.mes)}</span></div>
      <div class="mixbar" role="img" aria-label="Dinheiro ${Fmt.pct(din / tot * 100, 1)}, PIX ${Fmt.pct(pix / tot * 100, 1)}, Cartão ${Fmt.pct(cart / tot * 100, 1)}">
        ${[['din', din], ['pix', pix], ['cart', cart]].map(([k, v]) => v > 0 ? `<i style="width:${v / tot * 100}%;background:${RETAGUARDA_CFG.corModalidade[k]}" title="${Fmt.brl(v)}"></i>` : '').join('')}</div>
      <div class="mixleg">${[['din', 'Dinheiro', din], ['pix', 'PIX', pix], ['cart', 'Cartão', cart]].map(([k, r, v]) => `<div><span class="sw" style="background:${RETAGUARDA_CFG.corModalidade[k]}"></span><span>${r}</span><b class="mono">${Fmt.brl0(v)}</b><span class="hint">${Fmt.pct(v / tot * 100, 1)}</span></div>`).join('')}</div></div>`;
    const maxAbs = ranking[0]?.abs || 1, rkLista = u.verTodasLojas ? ranking : ranking.slice(0, 10);
    const rank = `<div class="panel"><div class="row between"><div><h2>Lojas com maiores divergências</h2><p class="sub">Ordenado pela soma das diferenças em valor absoluto no mês.</p></div></div>
      ${ranking.length ? `<ol class="rank">${rkLista.map((r, i) => `<li><span class="pos">${i + 1}</span><div class="info"><div class="row between" style="gap:6px"><b>${esc(this.nomeLoja(r.lojaId, r.texto))}</b><span class="mono">${Fmt.brl(r.abs)}</span></div>
          <div class="rbar"><i style="width:${Math.max(3, r.abs / maxAbs * 100)}%"></i></div>
          <div class="hint">${r.n} ocorrência${r.n > 1 ? 's' : ''} · líquida ${Fmt.brl(r.liq)} · maior ${Fmt.brl(r.maior)}</div></div></li>`).join('')}</ol>
        ${ranking.length > 10 ? `<button class="btn ghost sm" data-a="rt-cs-todas">${u.verTodasLojas ? 'Mostrar top 10' : `Ver todas (${ranking.length})`}</button>` : ''}`
        : '<div class="empty">Nenhuma divergência no período.</div>'}</div>`;
    const grafico = `<div class="panel"><div class="row between"><div><h2>Diferença líquida por dia</h2><p class="sub">Positivo: Websystem maior que o sistema interno. Negativo: sistema interno maior.</p></div></div>
      <div class="chart-box"><canvas id="csDia" role="img" aria-label="Diferença líquida por dia"></canvas></div></div>`;

    /* ---- tabela ---- */
    const q = this.norm(u.busca);
    const filtradas = linhas.filter(l => (u.filtro === 'todos' || l.st === u.filtro) && (!q || this.norm(this.nomeLoja(l.lojaId, l.texto)).includes(q)))
      .sort((a, b) => u.filtro === 'div' ? Math.abs(b.dif) - Math.abs(a.dif) : b.data.localeCompare(a.data) || (a.texto || '').localeCompare(b.texto || ''));
    const podeEd = Auth.can('retaguarda.credsystem.editar'), podeFalta = Auth.can('retaguarda.faltas.lancar');
    const pill = st => ({ ok: '<span class="pill ok">Conciliado</span>', div: '<span class="pill bad">Divergente</span>', pend: '<span class="pill warn">Aguardando lançamento</span>' })[st];
    const tabela = `<div class="panel"><div class="row between" style="margin-bottom:10px"><h2>Loja × dia</h2>
        <div class="seg">${[['div', `Divergências (${divs.length})`], ['pend', `Pendentes (${pend.length})`], ['todos', `Todos (${linhas.length})`]].map(([k, r]) => `<button class="${u.filtro === k ? 'on' : ''}" data-a="rt-cs-filtro" data-v="${k}">${r}${k === 'adquirentes' && !Auth.can('retaguarda.adq.ver') ? ' <span class="pill neutral" style="margin-left:4px">GESTOR</span>' : ''}</button>`).join('')}</div></div>
      <div class="field" style="max-width:340px;margin-bottom:10px"><label class="lbl" for="csBusca">Buscar loja</label><input id="csBusca" type="search" value="${esc(u.busca)}" data-a="rt-cs-busca" placeholder="Ex.: Palmares"></div>
      ${filtradas.length ? `<div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Loja</th><th class="num">Websystem</th><th class="num">Dinheiro</th><th class="num">PIX</th><th class="num">Cartão</th><th class="num">Diferença</th><th>Situação</th>${podeEd || podeFalta ? '<th></th>' : ''}</tr></thead><tbody>
        ${filtradas.slice(0, u.limite).map(l => `<tr><td class="mono">${Fmt.data(l.data)}</td><td>${esc(this.nomeLoja(l.lojaId, l.texto))}${!l.lojaId ? ' <span class="pill warn">loja não cadastrada</span>' : ''}${l.obs ? `<div class="cell-sub">${esc(l.obs)}</div>` : ''}</td>
          <td class="num">${Fmt.brl(l.web)}</td><td class="num">${l.din != null ? Fmt.brl(l.din) : '—'}</td><td class="num">${l.pix != null ? Fmt.brl(l.pix) : '—'}</td><td class="num">${l.cart != null ? Fmt.brl(l.cart) : '—'}</td>
          <td class="num"><b style="color:var(${l.st === 'div' ? '--bad' : '--ink-soft'})">${l.st === 'pend' ? '—' : Fmt.brl(l.dif)}</b></td><td>${pill(l.st)}</td>
          ${podeEd || podeFalta ? `<td class="acts">${podeEd ? `<button class="iconbtn" data-a="rt-cs-editar" data-doc="${l.docId}" data-k="${esc(l.chave)}" aria-label="Lançar ou corrigir valores do sistema interno">${ICON.editar}</button>` : ''}${podeFalta && l.st === 'div' && l.lojaId ? `<button class="btn ghost sm" data-a="rt-cs-falta" data-doc="${l.docId}" data-k="${esc(l.chave)}">Lançar falta</button>` : ''}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>${filtradas.length > u.limite ? `<button class="btn sec sm" style="margin-top:10px" data-a="rt-cs-mais">Mostrar mais (${filtradas.length - u.limite} restantes)</button>` : ''}`
        : '<div class="empty">Nada para mostrar com esse filtro.</div>'}</div>`;
    return topo + kpis + `<div class="grid g2 cs-top"><div class="stack">${mix}${grafico}</div>${rank}</div>` + tabela;
  },
  graficosCS({ dias }) {
    const pos = this.cor('--warn'), neg = this.cor('--accent'), grid = this.cor('--line-soft'), ink = this.cor('--ink-soft');
    this.grafico('csDia', {
      type: 'bar',
      data: { labels: dias.map(d => Fmt.data(d.data).slice(0, 5)), datasets: [{ label: 'Diferença líquida', data: dias.map(d => this.r2(d.dif)), backgroundColor: dias.map(d => d.dif >= 0 ? pos : neg), borderRadius: 4, maxBarThickness: 26 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${Fmt.brl(c.parsed.y)} · ${dias[c.dataIndex].n} divergência(s)` } } },
        scales: { x: { grid: { display: false }, ticks: { color: ink } }, y: { grid: { color: grid }, ticks: { color: ink, callback: v => Fmt.brl0(v) } } } },
    });
  },

  /** Importa o relatório do Websystem. Colunas reconhecidas pelo nome (a ordem não importa). */
  async importarCS(file) {
    const r = await this.lerPlanilha(file, {
      loja: ['LOJA', 'FILIAL'], data: ['DATA'], web: ['WEBSYSTEM', 'CREDSYSTEM', 'VALOR RECEBIDO', 'RECEBIDO', 'TOTAL'],
      din: ['DINHEIRO'], cart: ['CARTAO', 'CARTOES'], pix: ['PIX'],
    });
    if (r.colunas.web < 0) throw new Error('Não encontrei a coluna do valor recebido (WEBSYSTEM ou TOTAL).');
    // agrega por data e loja (linhas repetidas da mesma loja no mesmo dia são somadas)
    const porData = {}, naoCad = new Set(); let n = 0, invalidas = 0;
    for (const x of r.linhas) {
      const data = this.dataISO(x.data), web = this.num(x.web);
      if (!data || x.loja == null || web == null) { invalidas++; continue; }
      const lj = this.loja(x.loja); if (!lj.lojaId) naoCad.add(lj.texto);
      const chave = lj.lojaId || 'txt:' + this.norm(lj.texto);
      const vals = { din: this.num(x.din), cart: this.num(x.cart), pix: this.num(x.pix) };
      const temInterno = Object.values(vals).some(v => v != null);
      const alvo = (porData[data] ||= {})[chave] ||= { chave, lojaId: lj.lojaId, texto: lj.texto, web: 0, din: null, cart: null, pix: null, _interno: false };
      alvo.web = this.r2(alvo.web + web);
      if (temInterno) { alvo._interno = true; ['din', 'cart', 'pix'].forEach(k => { alvo[k] = this.r2((alvo[k] || 0) + (vals[k] || 0)); }); }
      n++;
    }
    const datas = Object.keys(porData).sort();
    if (!datas.length) throw new Error('Nenhuma linha válida (confira as colunas LOJA, DATA e WEBSYSTEM).');
    return { porData, datas, n, invalidas, naoCad: [...naoCad], aba: r.aba, nomeArquivo: file.name };
  },
  async aplicarCS(imp) {
    let docs = 0;
    for (const data of imp.datas) {
      const atual = Repo.get('credsystem', data), mapa = new Map((atual?.linhas || []).map(l => [l.chave, l]));
      for (const nova of Object.values(imp.porData[data])) {
        const velha = mapa.get(nova.chave) || {};
        const l = { ...velha, chave: nova.chave, lojaId: nova.lojaId, texto: nova.texto, web: nova.web };
        // valores internos do arquivo substituem; se o arquivo não trouxer, mantém o que foi digitado no painel
        if (nova._interno) { l.din = nova.din; l.cart = nova.cart; l.pix = nova.pix; }
        else { l.din = velha.din ?? null; l.cart = velha.cart ?? null; l.pix = velha.pix ?? null; }
        mapa.set(nova.chave, l);
      }
      const arquivos = [...(atual?.arquivos || []), { nome: imp.nomeArquivo, em: new Date().toISOString(), por: Auth.id }].slice(-5);
      await Repo.salvar('credsystem', data, { data, linhas: [...mapa.values()], arquivos }, { modulo: 'retaguarda', rotulo: `Credsystem ${Fmt.data(data)}`, detalhe: `Importação de ${imp.nomeArquivo}` });
      docs++; await sleep(80);
    }
    return docs;
  },
  editarLinhaCS(docId, chave) {
    const doc = Repo.get('credsystem', docId), l = doc.linhas.find(x => x.chave === chave);
    UI.modal({
      titulo: `Sistema interno · ${this.nomeLoja(l.lojaId, l.texto)} · ${Fmt.data(docId)}`,
      corpo: `<p class="hint" style="margin-top:0">Websystem: <b class="mono">${Fmt.brl(l.web)}</b>. Informe o que consta no sistema interno por modalidade.</p>
        <div class="form-grid">${campo('Dinheiro (R$)', 'din', l.din, { tipo: 'number' })}${campo('PIX (R$)', 'pix', l.pix, { tipo: 'number' })}${campo('Cartão (R$)', 'cart', l.cart, { tipo: 'number' })}
        <div class="field"><span class="lbl">Diferença</span><div id="csDifPrev" class="mono" style="font-size:18px;padding-top:6px">—</div></div>
        ${campo('Observação', 'obs', l.obs, { full: true, attrs: 'placeholder="Ex.: estorno lançado no dia seguinte"' })}</div>`,
      aoAbrir: m => { const upd = () => { const d = UI.lerForm(m); const s = this.statusLinha({ web: l.web, ...d }); $('#csDifPrev', m).textContent = s.st === 'pend' ? '—' : Fmt.brl(s.dif); $('#csDifPrev', m).style.color = s.st === 'div' ? 'var(--bad)' : 'var(--ok)'; }; m.addEventListener('input', upd); upd(); },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => {
        const d = UI.lerForm(m);
        await Repo.salvar('credsystem', docId, { ...doc, linhas: doc.linhas.map(x => x.chave === chave ? { ...x, ...d } : x) }, { modulo: 'retaguarda', rotulo: `Credsystem ${Fmt.data(docId)} · ${this.nomeLoja(l.lojaId, l.texto)}` });
        UI.toast('Conciliação atualizada');
      } }],
    });
  },

  /* =====================================================================
     2. FALTAS DE CAIXA
     ===================================================================== */
  itensFaltas() {
    return Repo.todos('faltas').flatMap(d => (d.itens || []).map(i => ({ ...i, lojaId: d.lojaId, docId: d.id })));
  },
  periodos() {
    const hoje = Datas.hojeISO().slice(0, 7);
    const meses = [...new Set([hoje, ...this.itensFaltas().map(i => i.data.slice(0, 7))])].sort().reverse();
    return [['ult3', 'Últimos 3 meses'], ['ano', 'Ano ' + hoje.slice(0, 4)], ...meses.map(m => [m, this.mesLabel(m)])];
  },
  noPeriodo(data, p) {
    const hoje = Datas.hoje();
    if (p === 'ult3') return data >= Datas.iso(new Date(hoje.getFullYear(), hoje.getMonth() - 2, 1));
    if (p === 'ano') return data.startsWith(String(hoje.getFullYear()));
    return data.startsWith(p);
  },
  /** Opções de caixa de uma loja: colaboradores do Módulo 1 lotados nela + base rápida de operadores. */
  caixasDaLoja(lojaId) {
    const funcs = Repo.todos('funcionarios').filter(f => f.lotacao === lojaId && (f.status || 'Ativo') !== 'Desligado')
      .sort((a, b) => (/caixa/i.test(b.cargo) - /caixa/i.test(a.cargo)) || a.nome.localeCompare(b.nome))
      .map(f => ({ tipo: 'func', id: f.id, nome: f.nome, matricula: f.matricula || '', rotulo: `${f.nome} · ${f.cargo || 'colaborador'}` }));
    const ops = (Repo.get('caixas', lojaId)?.operadores || []).filter(o => o.ativo !== false)
      .map(o => ({ tipo: 'op', id: o.id, nome: o.nome, matricula: o.matricula || '', rotulo: `${o.nome} · base de caixas` }));
    return [...funcs, ...ops];
  },
  chaveCaixa(i) { return i.caixa?.id ? i.caixa.tipo + ':' + i.caixa.id : 'txt:' + i.lojaId + ':' + this.norm(i.caixa?.nome); },

  renderFT() {
    if (!Repo.prontas.has('faltas')) return '<div class="panel"><p class="muted">Carregando faltas…</p></div>';
    const u = this.ui.ft; if (!u.periodo) u.periodo = Datas.hojeISO().slice(0, 7);
    const podeL = Auth.can('retaguarda.faltas.lancar'), podeCx = Auth.can('retaguarda.caixas.editar');
    const lojasOpt = Repo.todos('lojas').sort((a, b) => a.codigo.localeCompare(b.codigo));
    const topo = `<div class="row between" style="margin-bottom:14px">
        <div class="toolbar" style="margin:0;flex:1">
          <div class="field"><label class="lbl" for="ftPer">Período</label><select id="ftPer" data-a="rt-ft" data-k="periodo">${this.periodos().map(([v, l]) => `<option value="${v}" ${v === u.periodo ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="ftLoja">Loja</label><select id="ftLoja" data-a="rt-ft" data-k="loja"><option value="">Todas</option>${lojasOpt.map(l => `<option value="${l.id}" ${l.id === u.loja ? 'selected' : ''}>${l.codigo} · ${esc(l.nome)}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="ftSt">Situação</label><select id="ftSt" data-a="rt-ft" data-k="status"><option value="">Todas</option>${RETAGUARDA_CFG.statusFalta.map(s => `<option ${s === u.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
        </div>
        <div class="row">${podeCx ? '<button class="btn sec" data-a="rt-caixas">Base de caixas</button>' : ''}${podeL ? `<button class="btn sec" data-a="rt-ft-lote">Upload em lote</button><button class="btn" data-a="rt-ft-nova">+ Lançar falta</button>` : ''}</div></div>`;
    const itens = this.itensFaltas().filter(i => this.noPeriodo(i.data, u.periodo) && (!u.loja || i.lojaId === u.loja) && (!u.status || i.status === u.status));
    this._ftDados = null;
    if (!itens.length) return topo + `<div class="panel"><div class="empty">Nenhuma falta ou sobra lançada no período.${podeL ? ' Use “+ Lançar falta” ou o upload em lote.' : ''}</div></div>`;

    const faltas = itens.filter(i => i.tipo !== 'Sobra'), sobras = itens.filter(i => i.tipo === 'Sobra');
    const totF = this.r2(faltas.reduce((a, i) => a + i.valor, 0)), totS = this.r2(sobras.reduce((a, i) => a + i.valor, 0));
    const porCaixa = {}, porLoja = {};
    for (const i of faltas) {
      const k = this.chaveCaixa(i), c = porCaixa[k] ||= { chave: k, nome: i.caixa?.nome || '—', vinculado: !!i.caixa?.id, lojaId: i.lojaId, n: 0, valor: 0, dias: new Set(), desc: 0 };
      c.n++; c.valor += i.valor; c.dias.add(i.data); if (i.status === 'Descontada em folha') c.desc += i.valor;
      const l = porLoja[i.lojaId] ||= { lojaId: i.lojaId, n: 0, valor: 0, caixas: new Set() }; l.n++; l.valor += i.valor; l.caixas.add(k);
    }
    const rkCx = Object.values(porCaixa).sort((a, b) => b.valor - a.valor || b.n - a.n);
    const rkLj = Object.values(porLoja).sort((a, b) => b.valor - a.valor);
    const reinc = rkCx.filter(c => c.n >= RETAGUARDA_CFG.reincidenciaFaltas).length;
    const pctSt = s => totF ? faltas.filter(i => i.status === s).reduce((a, i) => a + i.valor, 0) / totF * 100 : 0;
    const semanas = {}; faltas.forEach(i => { const d = Datas.de(i.data); const seg = new Date(d); seg.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const k = Datas.iso(seg); const w = semanas[k] ||= { k, valor: 0, n: 0 }; w.valor += i.valor; w.n++; });
    this._ftDados = { semanas: Object.values(semanas).sort((a, b) => a.k.localeCompare(b.k)) };

    const kpis = `<div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Total em faltas</div><div class="v mono" style="color:var(--bad)">${Fmt.brl(totF)}</div><div class="d">${faltas.length} ocorrência(s) · média ${Fmt.brl(faltas.length ? totF / faltas.length : 0)}</div></div>
      <div class="kpi"><div class="k">Caixas envolvidos</div><div class="v">${rkCx.length}</div><div class="d">${reinc} reincidente(s) (${RETAGUARDA_CFG.reincidenciaFaltas}+ ocorrências)</div></div>
      <div class="kpi"><div class="k">Recuperado</div><div class="v">${Fmt.pct(pctSt('Descontada em folha'), 0)}</div><div class="d">descontado em folha · ${Fmt.pct(pctSt('Abonada'), 0)} abonado · ${Fmt.pct(pctSt('Em análise'), 0)} em análise</div></div>
      <div class="kpi"><div class="k">Sobras de caixa</div><div class="v mono">${Fmt.brl(totS)}</div><div class="d">${sobras.length} ocorrência(s) no período</div></div></div>`;
    const maxC = rkCx[0]?.valor || 1, lista = u.verTodos ? rkCx : rkCx.slice(0, 10);
    const rankCx = `<div class="panel"><h2>Ranking de quebras por caixa</h2><p class="sub">Valor total de faltas no período; índice = ocorrências e dias com falta.</p>
      <ol class="rank">${lista.map((c, i) => `<li><span class="pos">${i + 1}</span><div class="info"><div class="row between" style="gap:6px"><b>${esc(c.nome)}${c.n >= RETAGUARDA_CFG.reincidenciaFaltas ? ' <span class="pill bad">reincidente</span>' : ''}${!c.vinculado ? ' <span class="pill neutral">não vinculado</span>' : ''}</b><span class="mono">${Fmt.brl(c.valor)}</span></div>
        <div class="rbar bad"><i style="width:${Math.max(3, c.valor / maxC * 100)}%"></i></div>
        <div class="hint">${esc(this.nomeLoja(c.lojaId))} · ${c.n} ocorrência${c.n > 1 ? 's' : ''} em ${c.dias.size} dia${c.dias.size > 1 ? 's' : ''}${c.desc ? ` · ${Fmt.brl(c.desc)} descontado` : ''}</div></div></li>`).join('')}</ol>
      ${rkCx.length > 10 ? `<button class="btn ghost sm" data-a="rt-ft-todos">${u.verTodos ? 'Mostrar top 10' : `Ver todos (${rkCx.length})`}</button>` : ''}</div>`;
    const maxL = rkLj[0]?.valor || 1;
    const rankLj = `<div class="panel"><h2>Faltas por loja</h2><p class="sub">Soma das faltas e quantidade de caixas com ocorrência.</p>
      <ol class="rank">${rkLj.slice(0, 10).map((l, i) => `<li><span class="pos">${i + 1}</span><div class="info"><div class="row between" style="gap:6px"><b>${esc(this.nomeLoja(l.lojaId))}</b><span class="mono">${Fmt.brl(l.valor)}</span></div>
        <div class="rbar"><i style="width:${Math.max(3, l.valor / maxL * 100)}%"></i></div><div class="hint">${l.n} ocorrência(s) · ${l.caixas.size} caixa(s)</div></div></li>`).join('')}</ol></div>`;
    const graf = `<div class="panel"><h2>Faltas por semana</h2><p class="sub">Soma semanal (semana iniciando na segunda-feira).</p><div class="chart-box"><canvas id="ftSem" role="img" aria-label="Faltas por semana"></canvas></div></div>`;

    const q = this.norm(u.busca), podeSt = Auth.can('retaguarda.faltas.status'), podeEx = Auth.can('retaguarda.faltas.excluir');
    const tab = itens.filter(i => !q || this.norm([i.caixa?.nome, i.justificativa, this.nomeLoja(i.lojaId)].join(' ')).includes(q)).sort((a, b) => b.data.localeCompare(a.data));
    const tabela = `<div class="panel"><div class="row between" style="margin-bottom:10px"><h2>Lançamentos</h2>
        <div class="field" style="min-width:220px"><label class="lbl" for="ftBusca">Buscar</label><input id="ftBusca" type="search" value="${esc(u.busca)}" data-a="rt-ft-busca" placeholder="Caixa, loja, justificativa…"></div></div>
      <div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Loja</th><th>Caixa responsável</th><th>Tipo</th><th class="num">Valor</th><th>Justificativa</th><th>Situação</th><th></th></tr></thead><tbody>
      ${tab.map(i => `<tr><td class="mono">${Fmt.data(i.data)}</td><td>${esc(this.nomeLoja(i.lojaId))}</td><td>${esc(i.caixa?.nome || '—')}${i.caixa?.matricula ? `<div class="cell-sub mono">Mat. ${esc(i.caixa.matricula)}</div>` : ''}</td>
        <td><span class="pill ${i.tipo === 'Sobra' ? 'info' : 'bad'}">${esc(i.tipo || 'Falta')}</span></td><td class="num"><b>${Fmt.brl(i.valor)}</b></td>
        <td style="max-width:260px">${esc(i.justificativa || '—')}${i.origem && i.origem !== 'manual' ? `<div class="cell-sub">origem: ${esc(i.origem)}</div>` : ''}</td>
        <td>${podeSt ? `<select data-a="rt-ft-status" data-doc="${i.docId}" data-id="${i.id}" aria-label="Situação" style="min-width:150px">${RETAGUARDA_CFG.statusFalta.map(s => `<option ${s === i.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : `<span class="pill ${i.status === 'Abonada' || i.status === 'Justificada' ? 'ok' : i.status === 'Descontada em folha' ? 'navy' : 'warn'}">${esc(i.status)}</span>`}</td>
        <td class="acts">${Auth.can('retaguarda.faltas.lancar') ? `<button class="iconbtn" data-a="rt-ft-editar" data-doc="${i.docId}" data-id="${i.id}" aria-label="Editar">${ICON.editar}</button>` : ''}${podeEx ? `<button class="iconbtn" data-a="rt-ft-del" data-doc="${i.docId}" data-id="${i.id}" aria-label="Excluir">${ICON.lixo}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div><p class="hint" style="margin-top:8px">${tab.length} lançamento(s) · total ${Fmt.brl(tab.reduce((a, i) => a + (i.tipo === 'Sobra' ? 0 : i.valor), 0))} em faltas</p></div>`;
    return topo + kpis + `<div class="grid g2">${rankCx}${rankLj}</div>` + graf + tabela;
  },
  graficosFT({ semanas }) {
    const cor = this.cor('--bad'), grid = this.cor('--line-soft'), ink = this.cor('--ink-soft');
    this.grafico('ftSem', {
      type: 'bar',
      data: { labels: semanas.map(s => Fmt.data(s.k).slice(0, 5)), datasets: [{ label: 'Faltas', data: semanas.map(s => this.r2(s.valor)), backgroundColor: cor, borderRadius: 4, maxBarThickness: 34 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => 'Semana de ' + Fmt.data(semanas[it[0].dataIndex].k), label: c => ` ${Fmt.brl(c.parsed.y)} · ${semanas[c.dataIndex].n} ocorrência(s)` } } },
        scales: { x: { grid: { display: false }, ticks: { color: ink } }, y: { grid: { color: grid }, ticks: { color: ink, callback: v => Fmt.brl0(v) } } } },
    });
  },

  /** Formulário de lançamento/edição. `pre` preenche a partir de uma divergência do Credsystem. */
  abrirFalta(docId, itemId, pre = {}) {
    const doc = docId ? Repo.get('faltas', docId) : null, it = doc ? doc.itens.find(i => i.id === itemId) : null;
    const v = it ? { ...it, lojaId: doc.lojaId } : { data: Datas.hojeISO(), tipo: 'Falta', status: 'Em análise', ...pre };
    const lojas = Repo.todos('lojas').filter(l => l.ativa || l.id === v.lojaId).sort((a, b) => a.codigo.localeCompare(b.codigo));
    const podeSt = Auth.can('retaguarda.faltas.status');
    const opcoesCx = lojaId => {
      const cx = this.caixasDaLoja(lojaId), atual = v.caixa?.id ? v.caixa.tipo + ':' + v.caixa.id : (v.caixa?.nome ? 'txt' : '');
      return `<option value="">Selecione…</option>${cx.map(c => `<option value="${c.tipo}:${c.id}" ${atual === c.tipo + ':' + c.id ? 'selected' : ''}>${esc(c.rotulo)}</option>`).join('')}<option value="txt" ${atual === 'txt' ? 'selected' : ''}>Outro (digitar nome)</option>`;
    };
    UI.modal({
      titulo: it ? 'Editar lançamento' : 'Lançar falta de caixa',
      corpo: `<div class="form-grid">
        ${campo('Data', 'data', v.data, { tipo: 'date' })}
        ${campo('Loja', 'lojaId', v.lojaId || '', { opcoes: [['', 'Selecione…'], ...lojas.map(l => [l.id, `${l.codigo} · ${l.nome}`])] })}
        <div class="field"><label class="lbl" for="ftCx">Caixa responsável</label><select id="ftCx" name="_cx">${opcoesCx(v.lojaId)}</select></div>
        <div class="field" id="ftCxTxtBox" ${v.caixa && !v.caixa.id ? '' : 'hidden'}><label class="lbl" for="ftCxTxt">Nome do caixa</label><input id="ftCxTxt" type="text" name="_cxNome" value="${esc(!v.caixa?.id ? v.caixa?.nome || '' : '')}"></div>
        ${campo('Tipo', 'tipo', v.tipo || 'Falta', { opcoes: ['Falta', 'Sobra'] })}
        ${campo('Valor (R$)', 'valor', v.valor, { tipo: 'number', attrs: 'min="0" required' })}
        ${podeSt ? campo('Situação', 'status', v.status, { opcoes: RETAGUARDA_CFG.statusFalta }) : ''}
        ${campo('Justificativa', 'justificativa', v.justificativa, { tipo: 'textarea', full: true })}</div>
        <p class="hint">Não achou o caixa? Cadastre-o no Módulo 1 (lotado na loja) ou na Base de caixas.</p>`,
      aoAbrir: m => {
        $('[name="lojaId"]', m).addEventListener('change', e => { v.caixa = null; $('#ftCx', m).innerHTML = opcoesCx(e.target.value); $('#ftCxTxtBox', m).hidden = true; });
        $('#ftCx', m).addEventListener('change', e => { $('#ftCxTxtBox', m).hidden = e.target.value !== 'txt'; });
      },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: it ? 'Salvar' : 'Lançar', acao: async m => {
        const d = UI.lerForm(m);
        if (!d.data || !d.lojaId || !(d.valor > 0)) { UI.toast('Informe data, loja e valor.'); return false; }
        let caixa = null;
        if (d._cx === 'txt') { if (!d._cxNome) { UI.toast('Digite o nome do caixa.'); return false; } caixa = { tipo: 'txt', id: '', nome: d._cxNome, matricula: '' }; }
        else if (d._cx) { const c = this.caixasDaLoja(d.lojaId).find(x => x.tipo + ':' + x.id === d._cx); caixa = { tipo: c.tipo, id: c.id, nome: c.nome, matricula: c.matricula }; }
        else { UI.toast('Selecione o caixa responsável.'); return false; }
        const item = { id: it?.id || 'f-' + uid(), data: d.data, tipo: d.tipo, valor: this.r2(d.valor), caixa, justificativa: d.justificativa, status: d.status || it?.status || 'Em análise', origem: it?.origem || pre.origem || 'manual', lancadoPor: it?.lancadoPor || Auth.id, lancadoEm: it?.lancadoEm || new Date().toISOString() };
        if (it && (docId !== d.data.slice(0, 7) + '_' + d.lojaId)) await this.removerItem(docId, it.id, true); // mudou de mês/loja
        await this.gravarItens(d.lojaId, [item]);
        UI.toast(it ? 'Lançamento atualizado' : `${d.tipo} de ${Fmt.brl(d.valor)} lançada`);
      } }],
    });
  },
  /** Grava itens agrupando por documento mês_loja (substitui itens com o mesmo id). */
  async gravarItens(lojaId, itens, detalhe = '') {
    const grupos = {}; itens.forEach(i => (grupos[i.data.slice(0, 7) + '_' + lojaId] ||= []).push(i));
    for (const [docId, novos] of Object.entries(grupos)) {
      const atual = Repo.get('faltas', docId), mapa = new Map((atual?.itens || []).map(i => [i.id, i]));
      novos.forEach(i => mapa.set(i.id, i));
      await Repo.salvar('faltas', docId, { mes: docId.slice(0, 7), lojaId, itens: [...mapa.values()] }, { modulo: 'retaguarda', rotulo: `Faltas ${this.mesLabel(docId.slice(0, 7))} · ${this.nomeLoja(lojaId)}`, detalhe });
    }
  },
  async removerItem(docId, id, silencioso = false) {
    const doc = Repo.get('faltas', docId), it = doc.itens.find(i => i.id === id);
    if (!silencioso && !(await UI.confirmar('Excluir lançamento', `Excluir ${esc(it.tipo || 'falta')} de <b>${Fmt.brl(it.valor)}</b> (${esc(it.caixa?.nome || '')}, ${Fmt.data(it.data)})? A exclusão fica no log.`, 'Excluir', true))) return;
    await Repo.salvar('faltas', docId, { ...doc, itens: doc.itens.filter(i => i.id !== id) }, { modulo: 'retaguarda', rotulo: `Faltas · ${this.nomeLoja(doc.lojaId)}`, detalhe: 'Lançamento excluído' });
  },

  /** Upload em lote: DATA, LOJA, CAIXA, MATRICULA (opcional), VALOR, JUSTIFICATIVA, TIPO (opcional). */
  async importarFaltas(file) {
    const r = await this.lerPlanilha(file, {
      data: ['DATA'], loja: ['LOJA', 'FILIAL'], caixa: ['CAIXA', 'OPERADOR', 'FUNCIONARIO', 'COLABORADOR', 'NOME'],
      matricula: ['MATRICULA', 'MAT'], valor: ['VALOR'], justificativa: ['JUSTIFICATIVA', 'MOTIVO', 'OBS'], tipo: ['TIPO'], status: ['SITUACAO', 'STATUS'],
    });
    const ok = [], erros = []; let vinculados = 0;
    r.linhas.forEach((x, n) => {
      const data = this.dataISO(x.data), valor = this.num(x.valor), lj = this.loja(x.loja);
      if (!data || !(valor > 0) || !lj.lojaId) { erros.push(`Linha ${n + 2}: ${!lj.lojaId ? 'loja não encontrada (' + (x.loja ?? '') + ')' : !data ? 'data inválida' : 'valor inválido'}`); return; }
      const nome = String(x.caixa ?? '').trim(), mat = String(x.matricula ?? '').trim();
      const cx = this.caixasDaLoja(lj.lojaId).concat(Repo.todos('funcionarios').map(f => ({ tipo: 'func', id: f.id, nome: f.nome, matricula: f.matricula || '' })))
        .find(c => (mat && c.matricula && String(c.matricula) === mat) || (nome && this.norm(c.nome) === this.norm(nome)));
      if (cx) vinculados++;
      const tipo = this.norm(x.tipo) === 'SOBRA' ? 'Sobra' : 'Falta';
      const st = RETAGUARDA_CFG.statusFalta.find(s => this.norm(s) === this.norm(x.status)) || 'Em análise';
      ok.push({ lojaId: lj.lojaId, item: { id: 'f-' + uid(), data, tipo, valor: this.r2(valor), caixa: cx ? { tipo: cx.tipo, id: cx.id, nome: cx.nome, matricula: cx.matricula } : { tipo: 'txt', id: '', nome: nome || '(sem nome)', matricula: mat }, justificativa: String(x.justificativa ?? '').trim(), status: st, origem: 'lote: ' + file.name, lancadoPor: Auth.id, lancadoEm: new Date().toISOString() } });
    });
    return { ok, erros, vinculados, nome: file.name };
  },
  async baixarModeloFaltas() {
    const XLSX = await Libs.xlsx();
    const ws = XLSX.utils.aoa_to_sheet([['DATA', 'LOJA', 'CAIXA', 'MATRICULA', 'VALOR', 'JUSTIFICATIVA', 'TIPO'], ['01/09/2026', '14 - SHOP TACARUNA I', 'NOME DO CAIXA', '1234', 25.5, 'Troco errado no fechamento', 'Falta']]);
    ws['!cols'] = [{ wch: 12 }, { wch: 26 }, { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 40 }, { wch: 8 }];
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Faltas');
    await Documento.baixarArquivo('modelo_faltas_de_caixa.xlsx', new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })]));
  },
  abrirLote() {
    UI.modal({
      titulo: 'Upload em lote de faltas',
      corpo: `<p style="margin-top:0">Envie uma planilha com as colunas <b>DATA, LOJA, CAIXA, VALOR, JUSTIFICATIVA</b> (opcionais: MATRICULA, TIPO = Falta/Sobra, SITUACAO). A loja é reconhecida pelo número (ex.: “14 - TACARUNA”); o caixa é vinculado pela matrícula ou pelo nome.</p>
        <div class="row"><label class="btn" style="cursor:pointer">Escolher planilha<input type="file" accept=".xlsx,.xls,.csv" hidden id="ftLoteFile"></label><button class="btn ghost" type="button" id="ftModelo">Baixar modelo</button></div>
        <div id="ftLotePrev" style="margin-top:14px"></div>`,
      aoAbrir: m => {
        $('#ftModelo', m).addEventListener('click', () => this.baixarModeloFaltas());
        $('#ftLoteFile', m).addEventListener('change', async e => {
          const box = $('#ftLotePrev', m); box.innerHTML = '<p class="hint">Lendo…</p>';
          try {
            const imp = await this.importarFaltas(e.target.files[0]); this._lote = imp;
            const tot = imp.ok.reduce((a, x) => a + x.item.valor, 0);
            box.innerHTML = `<div class="note">${imp.ok.length} lançamento(s) prontos · ${Fmt.brl(tot)} · ${imp.vinculados} caixa(s) vinculados ao cadastro${imp.ok.length - imp.vinculados ? `, ${imp.ok.length - imp.vinculados} ficarão como “não vinculado”` : ''}.</div>
              ${imp.erros.length ? `<div class="note warn" style="margin-top:8px"><b>${imp.erros.length} linha(s) ignoradas:</b><br>${imp.erros.slice(0, 8).map(esc).join('<br>')}${imp.erros.length > 8 ? '<br>…' : ''}</div>` : ''}`;
          } catch (err) { box.innerHTML = `<div class="note warn">${esc(err.message)}</div>`; }
        });
      },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Importar lançamentos', acao: async () => {
        const imp = this._lote; if (!imp?.ok.length) { UI.toast('Escolha uma planilha válida.'); return false; }
        const porLoja = {}; imp.ok.forEach(x => (porLoja[x.lojaId] ||= []).push(x.item));
        for (const [lj, itens] of Object.entries(porLoja)) { await this.gravarItens(lj, itens, `Lote ${imp.nome}`); await sleep(60); }
        this._lote = null; UI.toast(`${imp.ok.length} lançamento(s) importados`);
      } }],
    });
  },

  /** Base rápida de caixas (operadores que não estão no Módulo 1). */
  abrirCaixas() {
    const lojas = Repo.todos('lojas').filter(l => l.ativa).sort((a, b) => a.codigo.localeCompare(b.codigo));
    const lista = () => {
      const docs = Repo.todos('caixas').filter(d => d.operadores?.length);
      const total = docs.reduce((a, d) => a + d.operadores.length, 0);
      return total ? `<div class="tbl-wrap" style="max-height:320px;overflow:auto"><table><thead><tr><th>Loja</th><th>Operador</th><th>Matrícula</th><th></th></tr></thead><tbody>
        ${docs.flatMap(d => d.operadores.map(o => `<tr><td>${esc(this.nomeLoja(d.id))}</td><td>${esc(o.nome)}</td><td class="mono">${esc(o.matricula || '—')}</td><td><button class="iconbtn" data-cx-del="${d.id}|${o.id}" aria-label="Remover">${ICON.lixo}</button></td></tr>`)).join('')}</tbody></table></div><p class="hint">${total} operador(es) na base rápida.</p>`
        : '<div class="empty" style="padding:18px">Nenhum operador na base rápida. Colaboradores do Módulo 1 lotados na loja já aparecem automaticamente.</div>';
    };
    UI.modal({
      titulo: 'Base de caixas', largo: true,
      corpo: `<p style="margin-top:0">A falta pode ser vinculada a <b>colaboradores do Módulo 1</b> (lotados na loja) ou a operadores desta base rápida.</p>
        <div class="form-grid">${campo('Loja', 'lojaId', '', { opcoes: [['', 'Selecione…'], ...lojas.map(l => [l.id, `${l.codigo} · ${l.nome}`])] })}${campo('Nome do operador', 'nome', '')}${campo('Matrícula', 'matricula', '')}
          <div class="field"><span class="lbl">&nbsp;</span><button type="button" class="btn sec" id="cxAdd">Adicionar</button></div></div>
        <div class="row" style="margin:12px 0"><label class="btn ghost" style="cursor:pointer">Upload rápido (.xlsx: LOJA, NOME, MATRICULA)<input type="file" hidden accept=".xlsx,.xls,.csv" id="cxFile"></label></div>
        <div id="cxLista">${lista()}</div>`,
      aoAbrir: m => {
        const refresh = () => { $('#cxLista', m).innerHTML = lista(); };
        const add = async (lojaId, ops) => {
          const doc = Repo.get('caixas', lojaId) || { lojaId, operadores: [] };
          const atuais = doc.operadores.slice();
          ops.forEach(o => { if (!atuais.some(a => this.norm(a.nome) === this.norm(o.nome))) atuais.push({ id: 'op-' + uid(), ativo: true, ...o }); });
          await Repo.salvar('caixas', lojaId, { lojaId, operadores: atuais }, { modulo: 'retaguarda', rotulo: 'Base de caixas · ' + this.nomeLoja(lojaId) });
        };
        $('#cxAdd', m).addEventListener('click', async () => { const d = UI.lerForm(m); if (!d.lojaId || !d.nome) return UI.toast('Informe loja e nome.'); await add(d.lojaId, [{ nome: d.nome.toUpperCase(), matricula: d.matricula }]); $('[name="nome"]', m).value = ''; $('[name="matricula"]', m).value = ''; refresh(); });
        $('#cxFile', m).addEventListener('change', async e => {
          try {
            const r = await this.lerPlanilha(e.target.files[0], { loja: ['LOJA', 'FILIAL'], nome: ['NOME', 'CAIXA', 'OPERADOR'], matricula: ['MATRICULA', 'MAT'] });
            const porLoja = {}; let ign = 0;
            r.linhas.forEach(x => { const lj = this.loja(x.loja); if (!lj.lojaId || !x.nome) { ign++; return; } (porLoja[lj.lojaId] ||= []).push({ nome: String(x.nome).trim().toUpperCase(), matricula: String(x.matricula ?? '').trim() }); });
            for (const [lj, ops] of Object.entries(porLoja)) { await add(lj, ops); await sleep(60); }
            refresh(); UI.toast(`Base atualizada: ${Object.values(porLoja).flat().length} operador(es)${ign ? `, ${ign} linha(s) ignoradas` : ''}.`);
          } catch (err) { UI.toast(err.message); }
        });
        m.addEventListener('click', async e => {
          const b = e.target.closest('[data-cx-del]'); if (!b) return;
          const [lj, id] = b.dataset.cxDel.split('|'), doc = Repo.get('caixas', lj);
          await Repo.salvar('caixas', lj, { ...doc, operadores: doc.operadores.filter(o => o.id !== id) }, { modulo: 'retaguarda', rotulo: 'Base de caixas · ' + this.nomeLoja(lj) }); refresh();
        });
      },
      acoes: [{ rotulo: 'Fechar', classe: 'sec' }],
    });
  },

  /* 3. IEO: ver retaguarda-fin.js */

  /* ======================= eventos ======================= */
  async acao(a, el) {
    if (/^rt-adq/.test(a)) return this.acaoAdq(a, el);
    const cs = this.ui.cs, ft = this.ui.ft;
    switch (a) {
      case 'rt-aba': if (el.dataset.v) { this.ui.aba = el.dataset.v; App.render(); } return;
      case 'rt-cs-filtro': cs.filtro = el.dataset.v; cs.limite = 150; return App.render();
      case 'rt-cs-mais': cs.limite += 300; return App.render();
      case 'rt-cs-todas': cs.verTodasLojas = !cs.verTodasLojas; return App.render();
      case 'rt-cs-editar': return this.editarLinhaCS(el.dataset.doc, el.dataset.k);
      case 'rt-cs-falta': {
        const doc = Repo.get('credsystem', el.dataset.doc), l = doc.linhas.find(x => x.chave === el.dataset.k), s = this.statusLinha(l);
        return this.abrirFalta(null, null, { data: doc.id, lojaId: l.lojaId, tipo: s.dif > 0 ? 'Falta' : 'Sobra', valor: Math.abs(s.dif), justificativa: `Divergência na conciliação Credsystem de ${Fmt.data(doc.id)} (Websystem ${Fmt.brl(l.web)} × sistema ${Fmt.brl(s.interno)})`, origem: 'conciliação Credsystem' });
      }
      case 'rt-ft-nova': return this.abrirFalta(null, null, { lojaId: ft.loja || '' });
      case 'rt-ft-editar': return this.abrirFalta(el.dataset.doc, el.dataset.id);
      case 'rt-ft-del': return this.removerItem(el.dataset.doc, el.dataset.id);
      case 'rt-ft-lote': return this.abrirLote();
      case 'rt-ft-todos': ft.verTodos = !ft.verTodos; return App.render();
      case 'rt-caixas': return this.abrirCaixas();
      default: return this.acaoFin(a, el);
    }
  },
  async mudanca(a, el) {
    if (/^rt-adq/.test(a)) return this.mudancaAdq(a, el);
    if (/^rt-ieo/.test(a)) return this.mudancaFin(a, el);
    if (a === 'rt-cs') { this.ui.cs[el.dataset.k] = el.value; this.ui.cs.limite = 150; return App.render(); }
    if (a === 'rt-ft') { this.ui.ft[el.dataset.k] = el.value; return App.render(); }
    if (a === 'rt-ft-status') {
      const doc = Repo.get('faltas', el.dataset.doc);
      return Repo.salvar('faltas', doc.id, { ...doc, itens: doc.itens.map(i => i.id === el.dataset.id ? { ...i, status: el.value, statusPor: Auth.id, statusEm: new Date().toISOString() } : i) }, { modulo: 'retaguarda', rotulo: `Faltas · ${this.nomeLoja(doc.lojaId)}`, detalhe: 'Situação: ' + el.value });
    }
    if (a === 'rt-cs-upload') {
      const f = el.files[0]; el.value = ''; if (!f) return;
      try {
        UI.toast('Lendo ' + f.name + '…');
        const imp = await this.importarCS(f);
        const periodo = `${Fmt.data(imp.datas[0])} a ${Fmt.data(imp.datas.at(-1))}`;
        const existentes = imp.datas.filter(d => Repo.get('credsystem', d)).length;
        if (!(await UI.confirmar('Importar conciliação Credsystem', `<b>${imp.n}</b> linha(s) de ${esc(imp.nomeArquivo)} (aba ${esc(imp.aba)}), período ${periodo}, ${imp.datas.length} dia(s).${existentes ? `<br>${existentes} dia(s) já existem: valores do arquivo substituem os anteriores; lançamentos digitados no painel são mantidos quando o arquivo vier sem eles.` : ''}${imp.naoCad.length ? `<br><br><b>Lojas não encontradas no cadastro:</b> ${imp.naoCad.map(esc).join(', ')}` : ''}${imp.invalidas ? `<br>${imp.invalidas} linha(s) sem data/valor ignoradas.` : ''}`, 'Importar'))) return;
        const n = await this.aplicarCS(imp);
        this.ui.cs.mes = imp.datas.at(-1).slice(0, 7); UI.toast(`Conciliação importada: ${n} dia(s).`); App.render();
      } catch (e) { UI.toast('Falha na importação: ' + e.message); }
    }
  },
  entrada(a, el) {
    if (a === 'rt-adq-busca') { this.ui.adq.busca = el.value; this.ui.adq.pagina = 1; return this.montarAdq(); }
    if (a === 'rt-cs-busca') { this.ui.cs.busca = el.value; App.render(); }
    if (a === 'rt-ft-busca') { this.ui.ft.busca = el.value; App.render(); }
    return this.entradaFin(a, el);
  },
};
