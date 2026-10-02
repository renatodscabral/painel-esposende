/* =====================================================================
   MÓDULO 2 — GESTÃO DE LOJAS
   Coleção lojas/<loja-XXX>: dados fiscais/operacionais, adquirentes/TEF e despesas fixas.
   Painel no topo (DOM puro + CSS): total de lojas, por regional (supervisor), por UF e por tipo.
   Contrato de locação e seguros da loja vêm da TABELA GLOBAL do Módulo 3 (contratos_locacao):
     • a aba "Contrato de locação" lê/grava o contrato da loja na tabela global (calculadora de reajuste inclusa);
     • a seção "Seguros da loja" mostra as apólices associadas à filial no Módulo 3, com o alerta de vigência.
   Base inicial: BASECADASTRO.xlsx (71 filiais, 213 registros de adquirente).
   ===================================================================== */
const INDICES = ['IGP-M', 'IPCA', 'INPC', 'IVAR', 'Fixo (sem índice)'];
const TIPOS_LOJA = ['RUA', 'SHOPPING', 'HIPERMERCADO'];
const BANDEIRAS = ['ESPOSENDE', 'ESPOSENDE SPORTS'];
const UFS = ['PE', 'PB', 'RN', 'AL', 'BA', 'CE', 'SE', 'PI', 'MA'];

const Lojas = {
  ui: { busca: '', bandeira: '', tipo: '', supervisor: '', uf: '', ativa: 'SIM', sel: null, aba: 'dados', calc: { pct: '', data: '' }, visao: 'lojas' }, // visao fica 'lojas' (fcx.js consulta)
  colecoes() { return ['lojas']; },

  /* ---------------- regras de negócio ---------------- */
  proximoReajuste(c) {
    if (c?.dataBaseReajuste) return Datas.de(c.dataBaseReajuste);
    const ini = Datas.de(c?.inicio); if (!ini) return null;
    const hoje = Datas.hoje(); let d = new Date(ini);
    while (d <= hoje) d = Datas.addAnos(d, 1);
    return d;
  },
  situacaoContrato(c) {
    const fim = Datas.de(c?.fim), hoje = Datas.hoje();
    if (!fim) return { cls: 'neutral', txt: c?.statusDocumento === 'FALTA' ? 'Contrato não localizado' : 'Prazo não informado' };
    const m = Datas.mesesEntre(hoje, fim), d = Datas.dias(hoje, fim);
    if (d < 0) return { cls: 'bad', txt: `Vencido há ${-d} dias`, m };
    if (m < 6) return { cls: 'bad', txt: `Vence em ${d} dias`, m };
    if (m < 18) return { cls: 'warn', txt: `Vence em ${m} meses`, m };
    return { cls: 'ok', txt: `${m} meses restantes`, m };
  },
  /** Janela da ação renovatória (Lei 8.245/91, art. 51 §5º): entre 1 ano e 6 meses antes do fim. */
  janelaRenovatoria(c) {
    const ini = Datas.de(c?.inicio), fim = Datas.de(c?.fim); if (!ini || !fim) return null;
    if (Datas.mesesEntre(ini, fim) < 60) return { aplica: false };
    return { aplica: true, de: Datas.addAnos(fim, -1), ate: Datas.addMeses(fim, -6) };
  },
  /** Apólices da filial (Módulo 3) em alerta de vigência: amarela (≤ 30 dias) ou vermelha (expirada). */
  segurosAlerta(l) { return this.segurosProntos() ? RadarSeguros.daLoja(l.id).filter(c => RadarSeguros.classificar(c).zona !== 'verde') : []; },
  segurosProntos() { return Repo.prontas.has(Contratos.pode() ? ContratosLocacao.COL : SegurosVigencia.COL); },
  filtradas() {
    const u = this.ui, q = u.busca.toLowerCase();
    return Repo.todos('lojas').filter(l =>
      (!u.bandeira || l.bandeira === u.bandeira) && (!u.tipo || l.tipo === u.tipo) && (!u.supervisor || l.supervisor === u.supervisor) && (!u.uf || l.uf === u.uf)
      && (!u.ativa || (u.ativa === 'SIM') === !!l.ativa)
      && (!q || [l.codigo, l.nome, l.cidade, l.cnpj, l.supervisor].join(' ').toLowerCase().includes(q))
    ).sort((a, b) => a.codigo.localeCompare(b.codigo));
  },

  /* ---------------- lista ---------------- */
  render() {
    if (this.ui.sel) return this.renderDetalhe(this.ui.sel);
    if (!Repo.prontas.has('lojas')) return `<div class="panel"><p class="muted">Carregando lojas…</p></div>`;
    const todas = Repo.todos('lojas'), ativas = todas.filter(l => l.ativa), u = this.ui, lista = this.filtradas();
    const hoje = Datas.hoje();
    const reaj = ativas.filter(l => { const d = this.proximoReajuste(this.contratoLoja(l).view); return d && Datas.dias(hoje, d) <= 60; }).length;
    const semContrato = ativas.filter(l => l.contrato?.statusDocumento === 'FALTA').length;
    const segVenc = ativas.filter(l => this.segurosAlerta(l).length).length;
    const cnpjInv = todas.filter(l => l.cnpj && !CNPJ.valido(l.cnpj)).length;
    const sup = [...new Set(todas.map(l => l.supervisor).filter(Boolean))].sort();
    const sel = (k, rot, ops) => `<div class="field"><label class="lbl" for="lj_${k}">${rot}</label><select id="lj_${k}" data-a="lj-filtro" data-k="${k}"><option value="">Todos</option>${ops.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${v === u[k] ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select></div>`;
    return `
      <div class="page-head"><div><h1>Gestão de Lojas</h1><p>Cadastro das filiais, adquirentes e TEF, despesas fixas e os seguros e contratos de cada loja (vindos do Módulo 3).</p></div>
        <div class="row">${Auth.can('lojas.importar') ? `<button class="btn sec" data-a="lj-importar">Importar BASECADASTRO (.xlsx)</button>` : ''}${Auth.can('lojas.editar') ? `<button class="btn" data-a="lj-nova">+ Nova loja</button>` : ''}</div></div>
      <section class="lj-dash" id="ljDash" aria-label="Painel das lojas"></section>
      <div class="grid g4" style="margin-bottom:16px">
        <div class="kpi"><div class="k">Contratos não localizados</div><div class="v" style="color:var(${semContrato ? '--warn' : '--ok'})">${semContrato}</div><div class="d">status “FALTA” na base</div></div>
        <div class="kpi"><div class="k">Reajustes em 60 dias</div><div class="v">${Contratos.pode() ? reaj : '—'}</div><div class="d">${Contratos.pode() ? 'pela data-base do contrato' : 'contratos restritos ao GESTOR'}</div></div>
        <div class="kpi zona-kpi ${segVenc ? 'warn' : 'ok'}"><div class="k">Lojas com seguro em alerta</div><div class="v" style="color:var(${segVenc ? '--warn' : '--ink'})">${this.segurosProntos() ? segVenc : '…'}</div><div class="d">apólice a 30 dias do fim ou expirada</div></div>
        <div class="kpi"><div class="k">CNPJ</div><div class="v" style="color:var(${cnpjInv ? '--bad' : '--ok'})">${cnpjInv}</div><div class="d">${cnpjInv ? 'CNPJ(s) com dígito inválido' : 'todos os CNPJs válidos'}</div></div>
      </div>
      <div class="panel">
        <div class="toolbar">
          <div class="field grow"><label class="lbl" for="ljBusca">Buscar</label><input id="ljBusca" type="search" placeholder="Código, nome, cidade, CNPJ…" value="${esc(u.busca)}" data-a="lj-busca"></div>
          ${sel('bandeira', 'Bandeira', BANDEIRAS)}${sel('tipo', 'Tipo', TIPOS_LOJA)}${sel('supervisor', 'Regional (supervisor)', sup)}${sel('uf', 'UF', [...new Set(todas.map(l => l.uf))].sort())}
          ${sel('ativa', 'Situação', [['SIM', 'Ativas'], ['NAO', 'Inativas']])}
        </div>
        <div class="tbl-wrap"><table><thead><tr><th>Loja</th><th>Bandeira · tipo</th><th>Cidade</th><th>Supervisor</th><th>CNPJ</th><th>Contrato</th><th>Seguro</th></tr></thead><tbody id="ljBody"></tbody></table></div>
        <p class="hint" style="margin-top:10px">${lista.length} de ${todas.length} lojas</p>
      </div>`;
  },
  linhaLoja(l) {
    const okc = CNPJ.valido(l.cnpj), segs = this.segurosProntos() ? RadarSeguros.daLoja(l.id) : [];
    const pior = segs.map(c => RadarSeguros.classificar(c)).sort((a, b) => ({ vermelha: 0, amarela: 1, verde: 2 }[a.zona] ?? 3) - ({ vermelha: 0, amarela: 1, verde: 2 }[b.zona] ?? 3))[0];
    const seg = !segs.length ? '<span class="hint">sem apólice</span>' : `<span class="pill ${RadarSeguros.ZONAS[pior?.zona]?.cls || 'neutral'}">${pior?.zona === 'verde' ? `${segs.length} vigente${segs.length > 1 ? 's' : ''}` : esc(pior?.txt || '—')}</span>`;
    const sc = this.situacaoContrato(l.contrato);
    return `<tr class="click" data-a="lj-abrir" data-id="${l.id}">
      <td><div class="cell-main"><span class="mono muted">${esc(l.codigo)}</span> ${esc(l.nome)}</div>${!l.ativa ? '<span class="pill neutral">inativa</span>' : ''}</td>
      <td><span class="pill ${l.bandeira === 'ESPOSENDE SPORTS' ? 'info' : 'navy'}">${l.bandeira === 'ESPOSENDE SPORTS' ? 'ES Sports' : 'Esposende'}</span> <span class="cell-sub">${esc(l.tipo)}</span></td>
      <td>${esc(l.cidade)}<span class="cell-sub"> / ${esc(l.uf)}</span></td>
      <td>${esc(l.supervisor || '—')}</td>
      <td><span class="mono" style="font-size:12px">${esc(l.cnpj || '—')}</span> ${l.cnpj ? `<span class="pill ${okc ? 'ok' : 'bad'}" title="${okc ? 'Dígitos verificadores conferem' : 'Dígitos verificadores não conferem'}">${okc ? ICON.ok : ICON.alerta}</span>` : ''}</td>
      <td>${Contratos.pillDaLoja(l) || `<span class="pill ${l.contrato?.statusDocumento === 'FALTA' ? 'warn' : Contratos.pode() ? 'neutral' : sc.cls}">${l.contrato?.statusDocumento === 'FALTA' ? 'Documento faltando' : Contratos.pode() ? 'sem contrato no Módulo 3' : esc(sc.txt)}</span>`}</td>
      <td>${seg}</td></tr>`;
  },
  /** Lista e painel montados com DocumentFragment (fora do innerHTML principal). */
  afterRender() {
    if (this.ui.sel) return this.montarSeguros();
    this.montarDashboard();
    const tb = $('#ljBody'); if (!tb) return;
    const lista = this.filtradas(), todas = Repo.todos('lojas');
    const tpl = document.createElement('template');
    tpl.innerHTML = lista.map(l => this.linhaLoja(l)).join('') || `<tr><td colspan="7"><div class="empty">${todas.length ? 'Nenhuma loja com esses filtros.' : 'Nenhuma loja cadastrada. Importe a BASECADASTRO.'}</div></td></tr>`;
    const frag = document.createDocumentFragment(); frag.appendChild(tpl.content); tb.replaceChildren(frag);
    UI.rotularTabelas(tb.closest('.tbl-wrap'));
  },

  /* ---------------- painel (dashboard) das lojas: CSS + DOM puro ---------------- */
  /** Contagens das lojas ATIVAS; recalculado a cada desenho, então reage a inclusão, edição e inativação. */
  dashDados() {
    const todas = Repo.todos('lojas'), ativas = todas.filter(l => l.ativa);
    const conta = (campo, ordem) => { const m = new Map(); ativas.forEach(l => { const k = String(l[campo] || '').trim() || '(não informado)'; m.set(k, (m.get(k) || 0) + 1); }); const arr = [...m.entries()]; return ordem ? ordem.map(k => [k, m.get(k) || 0]).concat(arr.filter(([k]) => !ordem.includes(k))) : arr.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])); };
    return { total: ativas.length, inativas: todas.length - ativas.length, esp: ativas.filter(l => l.bandeira === 'ESPOSENDE').length, sports: ativas.filter(l => l.bandeira === 'ESPOSENDE SPORTS').length,
      regional: conta('supervisor'), uf: conta('uf'), tipo: conta('tipo', ['RUA', 'SHOPPING', 'HIPERMERCADO']) };
  },
  montarDashboard() {
    const alvo = $('#ljDash'); if (!alvo) return;
    const d = this.dashDados(), u = this.ui, nomeTipo = { RUA: 'Rua', SHOPPING: 'Shopping', HIPERMERCADO: 'Hipermercado' };
    const barras = (k, linhas, rot = x => x) => {
      const max = Math.max(1, ...linhas.map(x => x[1]));
      return `<ul class="dash-barras">${linhas.map(([v, n]) => { const pct = d.total ? Math.round(n / d.total * 100) : 0, on = u[k] === v;
        return `<li><button type="button" class="dash-bar ${on ? 'on' : ''}" data-a="lj-dash" data-k="${k}" data-v="${esc(v)}" aria-pressed="${on}" title="${esc(rot(v))}: ${n} loja${n === 1 ? '' : 's'} ativa${n === 1 ? '' : 's'} (${pct}%) · clique para filtrar">
          <span class="dash-rot">${esc(rot(v))}</span><span class="dash-trilho" aria-hidden="true"><i style="width:${(n / max * 100).toFixed(1)}%"></i></span><span class="dash-num">${n}<small>${pct}%</small></span></button></li>`; }).join('')}</ul>`;
    };
    const tpl = document.createElement('template');
    tpl.innerHTML = `<div class="dash-card dash-total"><div class="k">Total de lojas</div><div class="dash-hero">${d.total}</div><div class="d">ativas · ${d.inativas} inativa${d.inativas === 1 ? '' : 's'}</div>
        <div class="dash-split"><span><b>${d.esp}</b> Esposende</span><span><b>${d.sports}</b> ES Sports</span></div></div>
      <div class="dash-card"><div class="k">Lojas por regional <span class="hint">(supervisor)</span></div>${barras('supervisor', d.regional)}</div>
      <div class="dash-card"><div class="k">Lojas por UF</div>${barras('uf', d.uf)}</div>
      <div class="dash-card"><div class="k">Lojas por tipo</div>${barras('tipo', d.tipo, v => nomeTipo[v] || v)}</div>`;
    const frag = document.createDocumentFragment(); frag.appendChild(tpl.content); alvo.replaceChildren(frag);
  },

  /* ---------------- detalhe ---------------- */
  renderDetalhe(id) {
    const l = Repo.get('lojas', id); if (!l) { this.ui.sel = null; return this.render(); }
    const nSeg = this.segurosProntos() ? RadarSeguros.daLoja(l.id).length : 0;
    const abas = [['dados', 'Dados fiscais e operacionais'], ['contrato', 'Contrato de locação'], ['adq', 'Adquirentes e TI'], ['despesas', 'Despesas fixas'], ['seguros', `Seguros${nSeg ? ` (${nSeg})` : ''}`]];
    const a = this.ui.aba;
    return `
      <div class="crumbs"><button data-a="lj-voltar">← Lojas</button><span>/</span><span>${esc(l.codigo)} · ${esc(l.nome)}</span></div>
      <div class="detail-head"><div><div class="code">FILIAL ${esc(l.codigo)} · ${esc(l.cnpj || 'sem CNPJ')}</div><h1>${esc(l.nome)}</h1>
        <div class="row" style="margin-top:6px"><span class="pill ${l.bandeira === 'ESPOSENDE SPORTS' ? 'info' : 'navy'}">${esc(l.bandeira)}</span><span class="pill neutral">${esc(l.tipo)}</span><span class="pill ${l.ativa ? 'ok' : 'neutral'}">${l.ativa ? 'Ativa' : 'Inativa'}</span></div></div>
        <div class="row"><button class="btn sec" data-a="lj-ficha" data-id="${id}">Imprimir ficha da loja</button></div></div>
      <div class="tabs">${abas.map(([k, r]) => `<button class="${a === k ? 'on' : ''}" data-a="lj-aba" data-v="${k}">${r}</button>`).join('')}</div>
      ${({ dados: () => this.abaDados(l), contrato: () => this.abaContrato(l), adq: () => this.abaAdq(l), despesas: () => this.abaDespesas(l), seguros: () => this.abaSeguros(l) })[a]()}`;
  },
  item(t, d) { return `<div><div class="t">${t}</div><div class="d">${d == null || d === '' ? '—' : d}</div></div>`; },
  abaDados(l) {
    const ok = CNPJ.valido(l.cnpj), h = l.horario || {};
    return `<div class="panel"><div class="row between"><h2>Dados fiscais e operacionais</h2>${Auth.can('lojas.editar') ? `<button class="btn sec sm" data-a="lj-editar-dados" data-id="${l.id}">${ICON.editar} Editar</button>` : ''}</div>
      <div class="dl" style="margin-top:14px">
        ${this.item('CNPJ', `<span class="mono">${esc(l.cnpj)}</span> <span class="pill ${ok ? 'ok' : 'bad'}">${ok ? 'válido' : 'dígito inválido'}</span>`)}
        ${this.item('Razão social', esc(l.razaoSocial || 'ESPOSENDE CALÇADOS LTDA'))}${this.item('Inscrição estadual', esc(l.inscricaoEstadual))}
        ${this.item('Endereço', esc(l.endereco))}${this.item('Cidade / UF', esc(l.cidade) + ' / ' + esc(l.uf))}${this.item('CEP', `<span class="mono">${esc(l.cep)}</span>`)}
        ${this.item('Tipo de loja', esc(l.tipo))}${this.item('Praça', esc(l.classificacao))}${this.item('Supervisor regional', esc(l.supervisor))}
        ${this.item('Faturamento médio mensal', l.faturamentoMedio ? `<span class="mono">${Fmt.brl0(l.faturamentoMedio)}</span>` : '')}${this.item('Área de vendas', l.areaM2 ? Fmt.num(l.areaM2) + ' m²' : '')}${this.item('Gerente da loja', esc(l.gerente))}
        ${this.item('Horário — seg. a sex.', esc(h.semana))}${this.item('Horário — sábado', esc(h.sabado))}${this.item('Horário — domingo/feriado', esc(h.domingo))}
      </div>
      ${l.receita ? `<div class="note" style="margin-top:16px">Dados da Receita Federal consultados em ${Fmt.dataHora(l.receita.consultadoEm)}: ${esc(l.receita.situacao || '')} · ${esc(l.receita.cnae || '')}</div>` : ''}
    </div>${this.secaoSeguros(l, false)}`;
  },
  formDados(l) {
    const h = l.horario || {};
    return `<div class="form-grid">
      ${campo('Código da filial', 'codigo', l.codigo, { attrs: l.id ? 'disabled' : 'required inputmode="numeric"' })}${campo('Nome da loja', 'nome', l.nome)}
      ${campo('Bandeira', 'bandeira', l.bandeira, { opcoes: BANDEIRAS })}${campo('Tipo', 'tipo', l.tipo, { opcoes: TIPOS_LOJA })}
      <div class="field"><label class="lbl" for="f_cnpj">CNPJ</label><div class="row" style="flex-wrap:nowrap"><input id="f_cnpj" name="cnpj" value="${esc(l.cnpj || '')}"><button type="button" class="btn sec sm" data-receita>Consultar Receita</button></div><span class="hint" data-receita-msg style="margin-top:4px"></span></div>
      ${campo('Inscrição estadual', 'inscricaoEstadual', l.inscricaoEstadual)}
      ${campo('Endereço', 'endereco', l.endereco, { full: true })}
      ${campo('Cidade', 'cidade', l.cidade)}${campo('UF', 'uf', l.uf, { opcoes: UFS })}${campo('CEP', 'cep', l.cep)}${campo('Praça / classificação', 'classificacao', l.classificacao)}
      ${campo('Supervisor regional', 'supervisor', l.supervisor)}${campo('Gerente da loja', 'gerente', l.gerente)}
      ${campo('Faturamento médio mensal (R$)', 'faturamentoMedio', l.faturamentoMedio, { tipo: 'number' })}${campo('Área de vendas (m²)', 'areaM2', l.areaM2, { tipo: 'number' })}
      ${campo('Horário seg. a sex.', 'horario.semana', h.semana, { attrs: 'placeholder="09:00 às 19:00"' })}${campo('Horário sábado', 'horario.sabado', h.sabado, { attrs: 'placeholder="09:00 às 17:00"' })}
      ${campo('Horário domingo/feriado', 'horario.domingo', h.domingo, { attrs: 'placeholder="Fechada / 12:00 às 18:00"' })}
      <div class="field"><span class="lbl">Situação</span><label class="check" style="padding-top:8px"><input type="checkbox" name="ativa" ${l.ativa !== false ? 'checked' : ''}> Loja ativa</label></div>
    </div>`;
  },
  abrirDados(id) {
    const l = id ? Repo.get('lojas', id) : { ativa: true, bandeira: 'ESPOSENDE', tipo: 'RUA', contrato: { statusDocumento: '', historico: [] }, adquirentes: [], despesas: { agua: {}, energia: {} }, seguros: [] };
    UI.modal({
      titulo: id ? 'Editar · ' + l.nome : 'Nova loja', largo: true, corpo: this.formDados(l),
      aoAbrir: m => {
        let ultimo = CNPJ.limpar(l.cnpj);
        const consultar = async () => {
          const msg = $('[data-receita-msg]', m), v = $('#f_cnpj', m).value; ultimo = CNPJ.limpar(v); msg.textContent = 'Consultando a Receita Federal…'; msg.style.color = '';
          const r = await Receita.consultar(v);
          if (CNPJ.limpar($('#f_cnpj', m).value) !== ultimo) return; // digitou outro CNPJ no meio da consulta
          if (!r.ok) { msg.textContent = r.motivo; msg.style.color = CNPJ.valido(v) ? 'var(--ink-soft)' : 'var(--bad)'; return; }
          Object.entries({ endereco: r.dados.endereco, cidade: r.dados.cidade, cep: r.dados.cep, uf: r.dados.uf }).forEach(([k, val]) => { const i = $(`[name="${k}"]`, m); if (i && val) { i.value = val; i.closest('.field')?.classList.add('ia-preenchido'); } });
          l._receita = { ...r.dados, consultadoEm: new Date().toISOString() };
          msg.textContent = `${r.dados.razaoSocial || ''}${r.dados.situacao ? ' · ' + r.dados.situacao : ''} — endereço, cidade, UF e CEP preenchidos com a Receita Federal. Revise e salve.`;
        };
        $('[data-receita]', m).addEventListener('click', consultar);
        // consulta automática ao terminar de digitar um CNPJ válido (provedor ligado em Configurações de Integração)
        $('#f_cnpj', m).addEventListener('input', e => { const d = CNPJ.limpar(e.target.value); if (Receita.provedor && d.length === 14 && d !== ultimo && CNPJ.valido(d)) consultar(); });
      },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, {
        rotulo: 'Salvar', acao: async m => {
          const d = UI.lerForm(m);
          const codigo = id ? l.codigo : String(d.codigo || '').replace(/\D/g, '').padStart(3, '0');
          if (!id && (!+codigo || Repo.get('lojas', 'loja-' + codigo))) { UI.toast('Informe um código de filial novo.'); return false; }
          d.cnpj = CNPJ.formatar(d.cnpj); if (l._receita) d.receita = l._receita; delete d.codigo;
          const novo = mergeProfundo(l, d); delete novo._receita; novo.codigo = codigo;
          await Repo.salvar('lojas', id || 'loja-' + codigo, novo, { modulo: 'lojas', rotulo: `${codigo} · ${d.nome}` });
          UI.toast('Loja salva'); if (!id) { this.ui.sel = 'loja-' + codigo; this.ui.aba = 'dados'; }
        }
      }],
    });
  },

  /* ---------------- contrato de locação (tabela global do Módulo 3) ---------------- */
  /** Contrato de locação da loja: tabela global → senão o que ainda está no cadastro da loja (versões anteriores). */
  contratoLoja(l) {
    const k = l.contrato || {}, legadoView = { ...k };
    if (!Contratos.pode() || !Repo.prontas.has(ContratosLocacao.COL)) return { fonte: 'restrito', view: legadoView };
    const g = ContratosLocacao.daLoja(l);
    if (g) return { fonte: 'global', doc: g, view: { valorAluguel: g.valor_atual, indice: g.indice_reajuste, aluguelPercentual: g.percentual_faturamento, condominio: g.condominio, fundoPromocao: g.fundo_promocao,
      locador: g.locador, garantia: g.garantia, inicio: g.data_inicio, fim: g.data_vencimento, dataBaseReajuste: g.data_base_reajuste, historico: g.historico_reajustes || [], observacoes: g.observacoes, statusDocumento: k.statusDocumento, arquivo: g.arquivo } };
    const leg = ContratosLocacao.legadoDaLoja(l);
    return { fonte: leg ? 'legado' : 'nenhum', doc: leg, view: legadoView };
  },
  abaContrato(l) {
    const cl = this.contratoLoja(l);
    if (cl.fonte === 'restrito') return `<div class="panel"><h2>Contrato de locação</h2><div class="empty">Os contratos de locação ficam no Módulo 3 e são restritos ao perfil GESTOR.${l.contrato?.statusDocumento ? ` Documento na base: <b>${esc(l.contrato.statusDocumento)}</b>.` : ''}</div></div>`;
    const podeEd = Contratos.podeEd();
    if (cl.fonte === 'nenhum') return `<div class="panel"><div class="row between"><div><h2>Contrato de locação</h2><p class="sub">Nenhum contrato desta loja na tabela global de contratos (Módulo 3).</p></div>
        ${podeEd ? `<button class="btn" data-a="ct-novo" data-l="${l.id}">+ Cadastrar contrato desta loja</button>` : ''}</div>
        <p class="hint" style="margin:0">O contrato cadastrado aqui é gravado na tabela global e aparece automaticamente no Módulo 3, no radar de renovatórias e no motor de aluguel do FCX.</p></div>
      ${this.blocoDocumentoIA(l, 'contrato', l.contrato?.arquivo, l.contrato?.resumoIA, 'Contrato digitalizado', 'Resumo do contrato')}`;
    const c = cl.view, pr = this.proximoReajuste(c), r = RadarRenovatoria.classificar(cl.doc), z = RadarRenovatoria.ZONAS[r.zona];
    const ini = Datas.de(c.inicio), fim = Datas.de(c.fim), hoje = Datas.hoje();
    const pctDecorrido = ini && fim ? Math.min(100, Math.max(0, (hoje - ini) / (fim - ini) * 100)) : 0;
    const global = cl.fonte === 'global', calc = this.ui.calc, pct = parseFloat(String(calc.pct).replace(',', '.')), val = Number(c.valorAluguel) || 0;
    const novo = !isNaN(pct) && val ? val * (1 + pct / 100) : null;
    const mesesRest = fim ? Math.max(0, Datas.mesesEntre(pr && pr > hoje ? pr : hoje, fim)) : 12;
    const editar = !podeEd ? '' : global ? `<button class="btn sec sm" data-a="ct-editar" data-id="${cl.doc.id}">${ICON.editar} Editar</button>` : `<button class="btn sm" data-a="ct-migrar" data-l="${l.id}">Migrar para o Módulo 3</button>`;
    return `${!global ? `<div class="note warn" style="margin-bottom:12px">Este contrato ainda está só no cadastro da loja (versão anterior). Ele já aparece no radar; migre-o para a tabela global para editar e aplicar reajustes.</div>` : ''}
      <div class="grid g2">
      <div class="panel"><div class="row between"><h2>Contrato de locação</h2>${editar}</div>
        <div class="dl" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:14px">
          ${this.item('Aluguel mensal (mínimo)', `<span class="mono" style="font-size:17px;font-weight:600">${Fmt.brl(c.valorAluguel)}</span>`)}${this.item('Índice de reajuste', esc(c.indice))}
          ${this.item('Aluguel percentual', c.aluguelPercentual ? Fmt.pct(c.aluguelPercentual) + ' do faturamento' : '')}${this.item('Condomínio + fundo de promoção', c.condominio || c.fundoPromocao ? Fmt.brl((Number(c.condominio) || 0) + (Number(c.fundoPromocao) || 0)) : '')}
          ${this.item('Locador', esc(c.locador))}${this.item('Garantia', esc(c.garantia))}
          ${this.item('Início', Fmt.data(c.inicio))}${this.item('Término', Fmt.data(c.fim))}
          ${this.item('Próximo reajuste', pr ? Fmt.data(Datas.iso(pr)) : '')}${this.item('Documento na base', esc(c.statusDocumento || '—'))}
          ${c.arquivo ? this.item('PDF no Módulo 3', `<a href="${esc(Arquivos.url(c.arquivo))}" target="_blank" rel="noopener">${esc(c.arquivo.nome || 'contrato.pdf')}</a>`) : ''}
        </div>
        <div style="margin-top:16px"><div class="row between" style="margin-bottom:6px"><span class="lbl" style="margin:0">Prazo de locação</span>${z ? `<span class="pill ${z.cls}" title="${esc(z.desc)}">${z.rotulo} · ${esc(RadarRenovatoria.prazoTexto(r))}</span>` : ''}</div>
          <div class="bar" role="progressbar" aria-valuenow="${Math.round(pctDecorrido)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pctDecorrido}%"></i></div>
          <div class="row between hint" style="margin-top:4px"><span>${Fmt.data(c.inicio)}</span><span>${Math.round(pctDecorrido)}% decorrido</span><span>${Fmt.data(c.fim)}</span></div></div>
        ${r.zona ? `<div class="note ${r.zona === 'amarela' ? 'warn' : ''}" style="margin-top:14px"><b>Ação renovatória</b> (Lei 8.245/91, art. 51): ajuizar entre ${Fmt.data(Datas.iso(r.janela.de))} e ${Fmt.data(Datas.iso(r.janela.ate))}.${r.zona === 'amarela' ? ' A janela está aberta agora.' : ''}${r.requisito5anos === false ? ' Confira o requisito de 5 anos (art. 51, II).' : ''}</div>` : ''}
        ${c.observacoes ? `<p style="margin:14px 0 0;white-space:pre-wrap" class="muted">${esc(c.observacoes)}</p>` : ''}
      </div>
      <div class="panel"><h2>Calculadora de reajuste</h2><p class="sub">Informe o índice acumulado dos últimos 12 meses (${esc(c.indice || 'IGP-M')}) na data-base.</p>
        <div class="form-grid">
          <div class="field"><label class="lbl" for="calcPct">Índice acumulado 12 meses (%)</label><input id="calcPct" type="text" inputmode="decimal" placeholder="Ex.: 4,35" value="${esc(calc.pct)}" data-a="lj-calc" data-k="pct"></div>
          <div class="field"><label class="lbl" for="calcData">Vigência do novo valor</label><input id="calcData" type="date" value="${esc(calc.data || (pr ? Datas.iso(pr) : Datas.hojeISO()))}" data-a="lj-calc" data-k="data"></div>
        </div>
        <div class="grid g3" style="margin-top:14px">
          <div class="kpi"><div class="k">Valor atual</div><div class="v mono" style="font-size:18px">${Fmt.brl(val || null)}</div></div>
          <div class="kpi"><div class="k">Novo aluguel</div><div class="v mono" style="font-size:18px;color:var(--accent)" id="calcNovo">${novo ? Fmt.brl(novo) : '—'}</div></div>
          <div class="kpi"><div class="k">Diferença mensal</div><div class="v mono" style="font-size:18px" id="calcDif">${novo ? Fmt.brl(novo - val) : '—'}</div></div>
        </div>
        <p class="hint" id="calcImpacto" style="margin-top:10px">${novo ? `Impacto em 12 meses: <b>${Fmt.brl((novo - val) * 12)}</b>${fim && mesesRest > 0 ? ` · até o fim do contrato (${mesesRest} meses): <b>${Fmt.brl((novo - val) * mesesRest)}</b>` : ''}.` : (val ? 'Digite o percentual para simular.' : 'Cadastre o valor do aluguel para usar a calculadora.')}</p>
        ${podeEd ? `<button class="btn" style="margin-top:8px" data-a="lj-aplicar-reajuste" data-id="${l.id}" ${novo && global ? '' : 'disabled'}${global ? '' : ' title="Migre o contrato para o Módulo 3 primeiro"'}>Aplicar reajuste ao contrato</button>` : ''}
        ${(c.historico || []).length ? `<h2 style="margin-top:20px;font-size:14px">Histórico de reajustes</h2><div class="tbl-wrap" style="margin-top:8px"><table><thead><tr><th>Vigência</th><th>Índice</th><th class="num">De</th><th class="num">Para</th></tr></thead><tbody>${c.historico.slice().reverse().map(h => `<tr><td class="mono">${Fmt.data(h.data)}</td><td>${esc(h.indice)} ${Fmt.pct(h.percentual)}</td><td class="num">${Fmt.brl(h.de)}</td><td class="num">${Fmt.brl(h.para)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div></div>
      ${this.blocoDocumentoIA(l, 'contrato', l.contrato?.arquivo, l.contrato?.resumoIA, 'Contrato digitalizado', 'Resumo do contrato')}`;
  },
  /** Reajuste gravado no contrato da tabela global (valor, histórico e próxima data-base). */
  async aplicarReajuste(id) {
    const l = Repo.get('lojas', id), cl = this.contratoLoja(l); if (cl.fonte !== 'global') return;
    const g = cl.doc, pct = parseFloat(String(this.ui.calc.pct).replace(',', '.')), val = Number(g.valor_atual);
    if (isNaN(pct) || !val) return;
    const novo = Math.round(val * (1 + pct / 100) * 100) / 100, data = $('#calcData')?.value || Datas.hojeISO();
    if (!(await UI.confirmar('Aplicar reajuste', `Atualizar o aluguel de <b>${Fmt.brl(val)}</b> para <b>${Fmt.brl(novo)}</b> (${g.indice_reajuste || 'índice'} ${Fmt.pct(pct)}) a partir de ${Fmt.data(data)}? A próxima data-base passa para ${Fmt.data(Datas.iso(Datas.addAnos(Datas.de(data), 1)))}.`, 'Aplicar'))) return;
    const hist = [...(g.historico_reajustes || []), { data, indice: g.indice_reajuste || '', percentual: pct, de: val, para: novo, por: Auth.id }];
    const { id: cid, ...x } = g;
    await ContratosLocacao.salvar(cid, { ...x, valor_atual: novo, historico_reajustes: hist, data_base_reajuste: Datas.iso(Datas.addAnos(Datas.de(data), 1)) }, `Reajuste ${Fmt.pct(pct)}`);
    this.ui.calc = { pct: '', data: '' }; UI.toast('Reajuste aplicado ao contrato (Módulo 3)');
  },

  /* ---------------- bloco: arquivo + resumo por IA (contrato e apólice) ---------------- */
  blocoDocumentoIA(l, tipo, arquivo, resumo, tituloArq, tituloRes, seguroId = '') {
    const sid = seguroId ? `data-s="${seguroId}"` : '';
    const podeArq = Arquivos.podeEnviar, podeIA = IA.disponivel;
    return `<div class="panel"><div class="row between"><div><h2>${tituloArq} e leitura inteligente</h2><p class="sub">Envie o PDF; a IA lê o documento e destaca os pontos críticos.</p></div>
      <div class="row">${podeArq ? `<label class="btn sec sm" style="cursor:pointer">${ICON.pdf} ${arquivo ? 'Substituir PDF' : 'Upload do PDF'}<input type="file" accept="application/pdf" hidden data-a="doc-upload" data-t="${tipo}" data-id="${l.id}" ${sid}></label>` : ''}
        ${podeIA ? `<button class="btn sm" data-a="doc-ia" data-t="${tipo}" data-id="${l.id}" ${sid} ${arquivo ? '' : 'disabled title="Envie o PDF primeiro"'}>${ICON.ia} ${resumo ? 'Refazer resumo' : 'Gerar resumo com IA'}</button>` : ''}</div></div>
      ${arquivo ? `<div class="filecard">${ICON.pdf}<div style="min-width:0;flex:1"><a href="${esc(Arquivos.url(arquivo))}" target="_blank" rel="noopener">${esc(arquivo.nome)}</a><div class="hint">${Fmt.num((arquivo.tamanho || 0) / 1024)} KB · enviado em ${Fmt.dataHora(arquivo.enviadoEm)}</div></div></div>`
        : `<div class="empty" style="padding:22px">Nenhum PDF enviado.${podeArq ? '' : ' O envio de arquivos é permitido ao perfil GESTOR.'}</div>`}
      ${!podeIA && !Cloud.caps.sample ? '<p class="hint" style="margin-top:8px">Leitura por IA desligada (o Master liga em Configurações de Integração).</p>' : ''}
      ${resumo ? this.renderResumo(tipo, resumo, l.id, seguroId) : ''}</div>`;
  },
  renderResumo(tipo, r, id, sid) {
    const crit = (r.pontosCriticos || []).slice().sort((a, b) => ({ alta: 0, media: 1, baixa: 2 }[a.severidade] ?? 3) - ({ alta: 0, media: 1, baixa: 2 }[b.severidade] ?? 3));
    const lista = (t, arr) => arr?.length ? `<div style="margin-top:12px"><div class="lbl">${t}</div><ul style="margin:4px 0;padding-left:18px">${arr.map(x => `<li>${esc(typeof x === 'string' ? x : [x.evento || x.nome, x.data ? Fmt.data(x.data) : '', x.detalhe || (x.limite ? Fmt.brl(x.limite) : ''), x.franquia ? 'franquia ' + x.franquia : ''].filter(Boolean).join(' — '))}</li>`).join('')}</ul></div>` : '';
    const fin = r.financeiro || {};
    return `<div class="ai-box" style="margin-top:16px"><div class="row between"><h4>${ICON.ia} Resumo gerado por IA</h4><span class="hint">${Fmt.dataHora(r.geradoEm)} · ${r.paginas || '?'} pág.</span></div>
      <p style="margin:8px 0 0">${esc(r.resumo)}</p>
      ${tipo === 'contrato' ? `<div class="dl" style="margin-top:12px">${this.item('Vigência', `${Fmt.data(r.vigencia?.inicio)} a ${Fmt.data(r.vigencia?.fim)}`)}${this.item('Aluguel', fin.aluguelMensal ? Fmt.brl(fin.aluguelMensal) : esc(fin.aluguelPercentual))}${this.item('Reajuste', esc([fin.indiceReajuste, fin.periodicidadeReajuste].filter(Boolean).join(' · ')))}</div>`
        : `<div class="dl" style="margin-top:12px">${this.item('Seguradora', esc(r.seguradora))}${this.item('Apólice', esc(r.numeroApolice))}${this.item('Vigência', `${Fmt.data(r.vigencia?.inicio)} a ${Fmt.data(r.vigencia?.fim)}`)}</div>`}
      ${crit.length ? `<div style="margin-top:12px"><div class="lbl">Pontos críticos</div>${crit.map(p => `<div class="crit"><span class="dot ${esc(p.severidade)}" title="Severidade ${esc(p.severidade)}"></span><div><b>${esc(p.titulo)}</b> <span class="pill ${p.severidade === 'alta' ? 'bad' : p.severidade === 'media' ? 'warn' : 'ok'}">${esc(p.severidade)}</span>${p.clausula ? ` <span class="hint">cláusula ${esc(p.clausula)}</span>` : ''}<div class="muted" style="font-size:13px">${esc(p.detalhe)}</div></div></div>`).join('')}</div>` : ''}
      ${tipo === 'contrato' ? lista('Prazos importantes', r.prazosImportantes) + lista('Encargos', fin.encargos) : lista('Coberturas', r.coberturas) + lista('Exclusões relevantes', r.exclusoesRelevantes) + lista('Obrigações do segurado', r.obrigacoesSegurado)}
      ${lista('Recomendações', r.recomendacoes)}
      ${Auth.can(tipo === 'contrato' ? 'lojas.contrato.editar' : 'lojas.editar') ? `<button class="btn sec sm" style="margin-top:12px" data-a="doc-aplicar" data-t="${tipo}" data-id="${id}" ${sid ? `data-s="${sid}"` : ''}>Aplicar datas e valores extraídos ao cadastro</button>` : ''}
      <p class="hint" style="margin-top:10px">Leitura automática: confira as cláusulas no documento original antes de decidir.</p></div>`;
  },
  async uploadDoc(el) {
    const file = el.files[0]; if (!file) return;
    const l = Repo.get('lojas', el.dataset.id), tipo = el.dataset.t, sid = el.dataset.s;
    UI.toast('Enviando ' + file.name + '…');
    try {
      const ref = await Arquivos.enviar(file);
      if (tipo === 'contrato') await Repo.salvar('lojas', l.id, { ...l, contrato: { ...l.contrato, arquivo: ref, statusDocumento: 'OK' } }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · contrato (arquivo)` });
      else await Repo.salvar('lojas', l.id, { ...l, seguros: l.seguros.map(s => s.id === sid ? { ...s, arquivo: ref } : s) }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · apólice (arquivo)` });
      UI.toast('Arquivo salvo. Agora você pode gerar o resumo com IA.');
      this._ultimoArquivo = { key: l.id + tipo + (sid || ''), file };
    } catch (e) { UI.toast('Falha no envio: ' + (e.code || e.message)); }
  },
  async resumoIA(el) {
    const l = Repo.get('lojas', el.dataset.id), tipo = el.dataset.t, sid = el.dataset.s;
    const alvo = tipo === 'contrato' ? l.contrato : l.seguros.find(s => s.id === sid);
    const status = UI.modal({ titulo: 'Leitura inteligente', corpo: `<p id="iaStatus" style="margin:0">Preparando…</p><p class="hint">Contratos longos podem levar até um minuto.</p>`, acoes: [] });
    try {
      const k = l.id + tipo + (sid || '');
      const blob = this._ultimoArquivo?.key === k ? this._ultimoArquivo.file : await Arquivos.blobDe(alvo.arquivo);
      const r = await IA.resumir(tipo === 'contrato' ? 'contrato' : 'apolice', blob, t => { const s = $('#iaStatus'); if (s) s.textContent = t; });
      if (tipo === 'contrato') await Repo.salvar('lojas', l.id, { ...l, contrato: { ...l.contrato, resumoIA: r } }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · resumo IA do contrato` });
      else await Repo.salvar('lojas', l.id, { ...l, seguros: l.seguros.map(s => s.id === sid ? { ...s, resumoIA: r } : s) }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · resumo IA da apólice` });
      status.fechar(); UI.toast('Resumo gerado');
    } catch (e) {
      status.fechar();
      const msg = { not_granted: 'Você não autorizou o uso da IA neste painel.', rate_limited: 'Muitas solicitações seguidas. Tente de novo em instantes.' }[e.code] || e.message || String(e);
      UI.toast('Não foi possível gerar o resumo: ' + msg);
    }
  },
  async aplicarExtraidos(el) {
    const l = Repo.get('lojas', el.dataset.id), tipo = el.dataset.t, sid = el.dataset.s;
    if (tipo === 'contrato') {
      const r = l.contrato.resumoIA, f = r.financeiro || {}, novo = { ...l.contrato };
      if (r.vigencia?.inicio) novo.inicio = r.vigencia.inicio; if (r.vigencia?.fim) novo.fim = r.vigencia.fim;
      if (f.aluguelMensal) novo.valorAluguel = f.aluguelMensal; if (f.indiceReajuste) novo.indice = INDICES.find(i => f.indiceReajuste.toUpperCase().includes(i.split(' ')[0])) || novo.indice;
      if (r.partes?.locador) novo.locador = r.partes.locador; if (f.garantia) novo.garantia = f.garantia;
      const muda = diffObjetos(l.contrato, novo).filter(x => !x.campo.startsWith('resumoIA'));
      if (!muda.length) return UI.toast('O cadastro já está igual ao documento.');
      if (!(await UI.confirmar('Aplicar dados extraídos', `Serão atualizados: <br>${muda.map(m => `<span class="chg"><b>${esc(m.campo)}</b>: ${esc(m.de)} → ${esc(m.para)}</span>`).join('<br>')}`, 'Aplicar'))) return;
      await Repo.salvar('lojas', l.id, { ...l, contrato: novo }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · contrato (dados da IA)` });
    } else {
      const s = l.seguros.find(x => x.id === sid), r = s.resumoIA;
      const novo = { ...s, seguradora: r.seguradora || s.seguradora, apolice: r.numeroApolice || s.apolice, inicio: r.vigencia?.inicio || s.inicio, vencimento: r.vigencia?.fim || s.vencimento, premio: r.premioTotal ?? s.premio };
      await Repo.salvar('lojas', l.id, { ...l, seguros: l.seguros.map(x => x.id === sid ? novo : x) }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · apólice (dados da IA)` });
    }
    UI.toast('Cadastro atualizado com os dados do documento');
  },

  /* ---------------- adquirentes e TI ---------------- */
  abaAdq(l) {
    const podeEd = Auth.can('lojas.editar');
    return `<div class="panel"><div class="row between"><div><h2>Adquirentes, TEF e TI</h2><p class="sub">EC, número lógico e CNPJ do TEF por adquirente. Base inicial: BASECADASTRO.</p></div>${podeEd ? `<button class="btn sec sm" data-a="adq-novo" data-id="${l.id}">+ Adicionar</button>` : ''}</div>
      ${(l.adquirentes || []).length ? `<div class="tbl-wrap"><table><thead><tr><th>Adquirente</th><th>Tipo · posição</th><th>EC</th><th>Número lógico</th><th>CNPJ do TEF</th><th>Concentradora</th><th>Integradora</th><th class="num">POS</th>${podeEd ? '<th></th>' : ''}</tr></thead><tbody>
      ${l.adquirentes.map((a, i) => `<tr><td class="cell-main">${esc(a.adquirente)}</td><td>${esc(a.tipo)}<div class="cell-sub">${esc(a.posicao)}</div></td><td class="mono">${esc(a.ec)}</td><td class="mono">${esc(a.codigoLogico)}</td>
        <td class="mono" style="font-size:12px">${esc(a.cnpjTef)}</td><td>${esc(a.concentradora)}</td><td>${esc(a.integradora)}</td><td class="num">${esc(a.qtdePos || '—')}</td>
        ${podeEd ? `<td style="white-space:nowrap"><button class="iconbtn" data-a="adq-editar" data-id="${l.id}" data-i="${i}" aria-label="Editar">${ICON.editar}</button>${Auth.can('lojas.excluir') ? `<button class="iconbtn" data-a="adq-del" data-id="${l.id}" data-i="${i}" aria-label="Remover">${ICON.lixo}</button>` : ''}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">Nenhum adquirente cadastrado.</div>'}
      <div class="dl" style="margin-top:18px">${this.item('Link de internet principal', esc(l.ti?.linkPrincipal))}${this.item('Link de contingência', esc(l.ti?.linkContingencia))}${this.item('Qtde. de PDVs', esc(l.ti?.pdvs))}</div>
      ${podeEd ? `<button class="btn ghost sm" style="margin-top:10px" data-a="ti-editar" data-id="${l.id}">${ICON.editar} Editar infraestrutura de TI</button>` : ''}</div>`;
  },
  abrirAdq(id, i) {
    const l = Repo.get('lojas', id), a = i != null ? l.adquirentes[i] : { adquirente: 'GETNET', tipo: 'CARTÃO TERCEIROS', posicao: 'PRIMÁRIA', integradora: 'SITEF' };
    UI.modal({
      titulo: (i != null ? 'Editar' : 'Novo') + ' adquirente · ' + l.nome, corpo: `<div class="form-grid">
      ${campo('Adquirente', 'adquirente', a.adquirente, { attrs: 'list="adqList"' })}${campo('Tipo', 'tipo', a.tipo, { opcoes: ['CARTÃO TERCEIROS', 'CARTÃO PRÓPRIO', 'PIX', 'VOUCHER'] })}
      ${campo('Posição', 'posicao', a.posicao, { opcoes: ['PRIMÁRIA', 'SECUNDÁRIA', 'CONTINGÊNCIA'] })}${campo('EC (estabelecimento comercial)', 'ec', a.ec)}
      ${campo('Número (código) lógico', 'codigoLogico', a.codigoLogico)}${campo('CNPJ do TEF', 'cnpjTef', a.cnpjTef)}
      ${campo('Empresa concentradora', 'concentradora', a.concentradora)}${campo('Integradora', 'integradora', a.integradora)}${campo('Qtde. de POS', 'qtdePos', a.qtdePos)}
      <datalist id="adqList"><option value="GETNET"><option value="CREDSYSTEM"><option value="CIELO"><option value="REDE"><option value="STONE"><option value="PAGSEGURO"></datalist></div>`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => { const d = UI.lerForm(m); d.cnpjTef = CNPJ.formatar(d.cnpjTef); const lista = [...(l.adquirentes || [])]; if (i != null) lista[i] = d; else lista.push(d); await Repo.salvar('lojas', id, { ...l, adquirentes: lista }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · adquirentes` }); } }],
    });
  },
  abrirTI(id) {
    const l = Repo.get('lojas', id), t = l.ti || {};
    UI.modal({ titulo: 'Infraestrutura de TI · ' + l.nome, corpo: `<div class="form-grid">${campo('Link principal (operadora/velocidade)', 'linkPrincipal', t.linkPrincipal)}${campo('Link de contingência', 'linkContingencia', t.linkContingencia)}${campo('Qtde. de PDVs', 'pdvs', t.pdvs)}</div>`, acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => { await Repo.salvar('lojas', id, { ...l, ti: UI.lerForm(m) }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · TI` }); } }] });
  },

  /* ---------------- despesas fixas ---------------- */
  abaDespesas(l) {
    const ag = l.despesas?.agua || {}, en = l.despesas?.energia || {}, podeEd = Auth.can('lojas.editar');
    return `<div class="grid g2">
      <div class="panel"><div class="row between"><h2>Água e esgoto</h2>${podeEd ? `<button class="btn sec sm" data-a="desp-editar" data-id="${l.id}" data-k="agua">${ICON.editar} Editar</button>` : ''}</div>
        <div class="dl" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:14px">${this.item('Operadora', esc(ag.operadora))}${this.item('Nº do contrato / matrícula', `<span class="mono">${esc(ag.contrato)}</span>`)}${this.item('Vencimento', ag.vencimento ? 'Dia ' + esc(ag.vencimento) : '')}${this.item('Valor médio mensal', ag.valorMedio ? Fmt.brl(ag.valorMedio) : '')}</div>
        ${l.tipo === 'SHOPPING' ? '<p class="hint" style="margin-top:12px">Em shopping, água costuma vir rateada no condomínio.</p>' : ''}</div>
      <div class="panel"><div class="row between"><h2>Energia elétrica</h2>${podeEd ? `<button class="btn sec sm" data-a="desp-editar" data-id="${l.id}" data-k="energia">${ICON.editar} Editar</button>` : ''}</div>
        <div class="dl" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:14px">${this.item('Operadora', esc(en.operadora))}${this.item('Nº do contrato / UC', `<span class="mono">${esc(en.contrato)}</span>`)}${this.item('Vencimento', en.vencimento ? 'Dia ' + esc(en.vencimento) : '')}${this.item('Valor médio mensal', en.valorMedio ? Fmt.brl(en.valorMedio) : '')}
        ${this.item('Compensação solar', en.compensacaoSolar ? `<span class="pill ok">${ICON.ok} Sim</span>` : '<span class="pill neutral">Não</span>')}${this.item('Usina / desconto', en.compensacaoSolar ? esc([en.usina, en.desconto ? Fmt.pct(en.desconto, 0) + ' de desconto' : ''].filter(Boolean).join(' · ')) : '')}</div></div></div>`;
  },
  abrirDespesa(id, k) {
    const l = Repo.get('lojas', id), d = l.despesas?.[k] || {};
    const ops = k === 'agua' ? ['COMPESA', 'CAGEPA', 'CAERN', 'CASAL', 'EMBASA', 'Rateio condomínio'] : ['Neoenergia Pernambuco', 'Energisa Paraíba', 'Neoenergia Cosern', 'Equatorial Alagoas', 'Neoenergia Coelba', 'Rateio condomínio'];
    UI.modal({
      titulo: (k === 'agua' ? 'Água' : 'Energia') + ' · ' + l.nome, corpo: `<div class="form-grid">${campo('Operadora', 'operadora', d.operadora, { attrs: 'list="opList"' })}${campo(k === 'agua' ? 'Nº do contrato / matrícula' : 'Nº do contrato / unidade consumidora', 'contrato', d.contrato)}
      ${campo('Dia de vencimento', 'vencimento', d.vencimento, { tipo: 'number', attrs: 'min="1" max="31"' })}${campo('Valor médio mensal (R$)', 'valorMedio', d.valorMedio, { tipo: 'number' })}
      ${k === 'energia' ? `<div class="field full"><label class="check"><input type="checkbox" name="compensacaoSolar" ${d.compensacaoSolar ? 'checked' : ''}> Possui compensação solar (geração distribuída)</label></div>${campo('Usina / fornecedor da energia solar', 'usina', d.usina)}${campo('Desconto contratado (%)', 'desconto', d.desconto, { tipo: 'number' })}` : ''}
      <datalist id="opList">${ops.map(o => `<option value="${o}">`).join('')}</datalist></div>`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => { await Repo.salvar('lojas', id, { ...l, despesas: { ...(l.despesas || {}), [k]: UI.lerForm(m) } }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · ${k}` }); } }],
    });
  },

  /* ---------------- seguros da loja (apólices do Módulo 3) ---------------- */
  abaSeguros(l) { return this.secaoSeguros(l, true); },
  /** Seção montada depois (DocumentFragment) em #ljSeg; completo = coberturas e pagamento por extenso. */
  secaoSeguros(l, completo) {
    const pend = (l.seguros || []).length;
    return `<section class="panel lj-seg" aria-labelledby="ljSegTit"><div class="row between"><div><h2 id="ljSegTit">Seguros da loja</h2><p class="sub" style="margin:0">Apólices associadas a esta filial no Módulo 3 · alerta amarelo a 30 dias do fim e vermelho quando expira.</p></div>
        ${Contratos.podeEd() ? `<button class="btn sec sm" data-a="ct-novo" data-t="seguro" data-l="${l.id}">+ Nova apólice</button>` : ''}</div>
      ${pend ? `<div class="note warn" style="margin-top:10px">${pend} apólice(s) antiga(s) do cadastro desta loja aguardam migração para o Módulo 3 (ela roda quando um GESTOR abre o painel).</div>` : ''}
      <div id="ljSeg" data-loja="${l.id}" data-completo="${completo ? 1 : 0}" style="margin-top:12px"><p class="muted" style="margin:0">Carregando…</p></div></section>`;
  },
  montarSeguros() {
    const alvo = $('#ljSeg'); if (!alvo) return;
    const l = Repo.get('lojas', alvo.dataset.loja), completo = alvo.dataset.completo === '1', gestor = Contratos.pode();
    if (!this.segurosProntos()) return;
    const segs = RadarSeguros.daLoja(l.id), Z = RadarSeguros.ZONAS;
    const alerta = segs.map(c => ({ c, r: RadarSeguros.classificar(c) })).filter(x => x.r.zona && x.r.zona !== 'verde');
    const card = c => {
      const r = RadarSeguros.classificar(c), z = Z[r.zona], p = c.premios || {}, pg = c.pagamento || {}, cob = c.coberturas || [], outras = (c.lojas_ids || []).length - 1;
      const cobs = completo ? cob : cob.slice(0, 3);
      return `<article class="seg-card ${r.zona ? 'z-' + r.zona : ''}">
        <header><div><b>${esc(c.seguradora || 'Seguradora não informada')}</b><div class="cell-sub">${esc(c.ramo || 'Seguro')}${c.numero_apolice ? ` · apólice ${esc(c.numero_apolice)}` : ''}</div></div>
          ${z ? `<span class="pill ${z.cls}">${r.zona !== 'verde' ? ICON.alerta + ' ' : ''}${esc(r.txt)}</span>` : '<span class="pill neutral">sem vencimento</span>'}</header>
        <div class="dl seg-dl">${this.item('Vigência', `${Fmt.data(c.data_inicio)} a ${Fmt.data(c.data_vencimento)}`)}
          ${gestor ? this.item('Prêmio total', p.total ? `<span class="mono">${Fmt.brl(p.total)}</span>` : '') + this.item('Pagamento', esc([pg.parcelas ? `${pg.parcelas}x de ${Fmt.brl(pg.valor_parcela)}` : '', pg.forma, pg.primeiro_vencimento ? `1º venc. ${Fmt.data(pg.primeiro_vencimento)}` : ''].filter(Boolean).join(' · '))) : ''}
          ${this.item('Filiais', outras > 0 ? `esta e mais ${outras}` : 'só esta filial')}</div>
        ${gestor && cobs.length ? `<table class="nolabel seg-cob"><thead><tr><th>Cobertura</th><th class="num">Limite (LMI)</th><th>Franquia</th></tr></thead><tbody>${cobs.map(x => `<tr><td>${esc(x.nome)}</td><td class="num">${x.limite != null ? Fmt.brl(x.limite) : '—'}</td><td class="cell-sub">${esc(x.franquia || '—')}</td></tr>`).join('')}</tbody></table>${cob.length > cobs.length ? `<p class="hint" style="margin:6px 0 0">+ ${cob.length - cobs.length} cobertura(s) na aba Seguros.</p>` : ''}` : ''}
        ${gestor && completo && pg.observacao ? `<p class="hint" style="margin:8px 0 0">${esc(pg.observacao)}</p>` : ''}
        ${!gestor ? '<p class="hint" style="margin:8px 0 0">Valores, coberturas e pagamento: perfil GESTOR (Módulo 3).</p>' : ''}
        ${gestor ? `<footer>${c.arquivo ? `<a href="${esc(Arquivos.url(c.arquivo))}" target="_blank" rel="noopener">${ICON.pdf} ${esc(c.arquivo.nome || 'apolice.pdf')}</a>` : '<span></span>'}${Contratos.podeEd() ? `<button class="btn ghost sm" data-a="ct-editar" data-id="${c.id}">Abrir no Módulo 3</button>` : ''}</footer>` : ''}</article>`;
    };
    const tpl = document.createElement('template');
    tpl.innerHTML = (alerta.length ? `<div class="alerta-seg ${alerta.some(x => x.r.zona === 'vermelha') ? 'bad' : 'warn'}" role="alert">${ICON.alerta}<div>${alerta.map(x => `<b>${esc(x.c.seguradora || 'Apólice')}</b> ${esc(x.r.txt)}`).join(' · ')}</div></div>` : '')
      + (segs.length ? `<div class="seg-grid">${segs.map(card).join('')}</div>` : `<div class="empty" style="padding:18px">Nenhuma apólice associada a esta filial no Módulo 3.</div>`);
    const frag = document.createDocumentFragment(); frag.appendChild(tpl.content); alvo.replaceChildren(frag);
  },

  /* ---------------- ficha imprimível ---------------- */
  ficha(id) {
    const l = Repo.get('lojas', id), cl = this.contratoLoja(l), c = { ...cl.view, inicio: cl.view.inicio, fim: cl.view.fim }, h = l.horario || {}, pr = this.proximoReajuste(c);
    const segs = this.segurosProntos() ? RadarSeguros.daLoja(l.id) : [];
    const g = pares => `<div class="grid">${pares.map(([t, d]) => `<div><div class="t">${t}</div><div class="d">${d == null || d === '' ? '—' : d}</div></div>`).join('')}</div>`;
    const corpo = `${Documento.cabecalho('Ficha Cadastral da Loja', `${l.codigo} · ${l.nome}`)}
      <h1>${esc(l.codigo)} · ${esc(l.nome)}</h1><p style="margin:4px 0 0"><span class="pill">${esc(l.bandeira)}</span> <span class="pill">${esc(l.tipo)}</span> <span class="pill">${l.ativa ? 'ATIVA' : 'INATIVA'}</span></p>
      <h2>Dados fiscais e operacionais</h2>${g([['CNPJ', esc(l.cnpj) + (CNPJ.valido(l.cnpj) ? '' : ' (verificar dígito)')], ['Inscrição estadual', esc(l.inscricaoEstadual)], ['Supervisor', esc(l.supervisor)], ['Endereço', esc(l.endereco)], ['Cidade / UF', `${esc(l.cidade)} / ${esc(l.uf)}`], ['CEP', esc(l.cep)], ['Faturamento médio', l.faturamentoMedio ? Fmt.brl0(l.faturamentoMedio) : ''], ['Gerente', esc(l.gerente)], ['Praça', esc(l.classificacao)], ['Seg. a sex.', esc(h.semana)], ['Sábado', esc(h.sabado)], ['Domingo/feriado', esc(h.domingo)]])}
      <h2>Contrato de locação</h2>${cl.fonte === 'restrito' ? '<p>Restrito ao perfil GESTOR (Módulo 3).</p>' : g([['Aluguel mensal', Fmt.brl(c.valorAluguel)], ['Índice', esc(c.indice)], ['Próximo reajuste', pr ? Fmt.data(Datas.iso(pr)) : ''], ['Início', Fmt.data(c.inicio)], ['Término', Fmt.data(c.fim)], ['Situação', esc(this.situacaoContrato(c).txt)], ['Locador', esc(c.locador)], ['Garantia', esc(c.garantia)], ['Documento', esc(c.statusDocumento)]])}
      ${c.resumoIA?.pontosCriticos?.length ? `<div class="box foco"><h3>Pontos críticos do contrato (leitura por IA)</h3><ul>${c.resumoIA.pontosCriticos.map(p => `<li><b>${esc(p.titulo)}</b> (${esc(p.severidade)}): ${esc(p.detalhe)}</li>`).join('')}</ul></div>` : ''}
      <h2>Adquirentes e TEF</h2><table><thead><tr><th>Adquirente</th><th>Tipo</th><th>Posição</th><th>EC</th><th>Nº lógico</th><th>CNPJ TEF</th></tr></thead><tbody>${(l.adquirentes || []).map(a => `<tr><td>${esc(a.adquirente)}</td><td>${esc(a.tipo)}</td><td>${esc(a.posicao)}</td><td>${esc(a.ec)}</td><td>${esc(a.codigoLogico)}</td><td>${esc(a.cnpjTef)}</td></tr>`).join('')}</tbody></table>
      <h2>Despesas fixas</h2>${g([['Água — operadora', esc(l.despesas?.agua?.operadora)], ['Água — contrato', esc(l.despesas?.agua?.contrato)], ['Água — vencimento', l.despesas?.agua?.vencimento ? 'Dia ' + esc(l.despesas.agua.vencimento) : ''], ['Energia — operadora', esc(l.despesas?.energia?.operadora)], ['Energia — contrato/UC', esc(l.despesas?.energia?.contrato)], ['Compensação solar', l.despesas?.energia?.compensacaoSolar ? 'Sim' : 'Não']])}
      <h2>Seguros</h2>${segs.length ? `<table><thead><tr><th>Ramo</th><th>Seguradora</th><th>Apólice</th><th>Vigência</th><th>Situação</th>${Contratos.pode() ? '<th>Prêmio total</th>' : ''}</tr></thead><tbody>${segs.map(s => `<tr><td>${esc(s.ramo)}</td><td>${esc(s.seguradora)}</td><td>${esc(s.numero_apolice)}</td><td>${Fmt.data(s.data_inicio)} a ${Fmt.data(s.data_vencimento)}</td><td>${esc(RadarSeguros.classificar(s).txt)}</td>${Contratos.pode() ? `<td>${Fmt.brl(s.premios?.total)}</td>` : ''}</tr>`).join('')}</tbody></table>` : '<p>Nenhuma apólice associada no Módulo 3.</p>'}
      <div class="foot">Esposende · Painel de Gestão — ficha gerada a partir do cadastro vigente</div>`;
    Documento.previa('Ficha · ' + l.nome, Documento.montar('Ficha da Loja ' + l.codigo, corpo), `Ficha_Loja_${l.codigo}_${l.nome.replace(/\W+/g, '_')}`);
  },

  /* ---------------- importação da BASECADASTRO ---------------- */
  async importar(file) {
    const XLSX = await Libs.xlsx();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = n => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null }) : [];
    const cod = s => { const m = String(s ?? '').match(/^\s*(\d+)/); return m ? m[1].padStart(3, '0') : null; };
    const limpa = v => v == null ? '' : String(v).replace(/\s+/g, ' ').trim();
    const titulo = s => limpa(s).toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase());
    const geral = rows('CADASTRO GERAL DE LOJAS'); if (!geral.length) throw new Error('Aba "CADASTRO GERAL DE LOJAS" não encontrada.');
    const classif = Object.fromEntries(rows('LOJAS').slice(1).filter(r => r[0]).map(r => [cod(r[0]), limpa(r[1])]));
    const contr = Object.fromEntries(rows('CONTRATO ').concat(rows('CONTRATO')).filter(r => r[0] && cod(r[0])).map(r => [cod(r[0]), limpa(r[1])]));
    const adq = {};
    rows('ADQUIRENTES POR LOJA').slice(1).filter(r => r[0]).forEach(r => (adq[cod(r[0])] ||= []).push({ adquirente: limpa(r[1]), tipo: limpa(r[2]), posicao: limpa(r[3]), concentradora: limpa(r[4]), cnpjTef: CNPJ.formatar(String(r[5] ?? '').padStart(14, '0')), codigoLogico: limpa(r[6]), ec: limpa(r[7]), qtdePos: ['NÃO APLICÁVEL', null].includes(r[8]) ? '' : limpa(r[8]), integradora: limpa(r[9]) }));
    const base = geral.slice(1).filter(r => r[0]).map(r => { const c = cod(r[0]); return { codigo: c, nome: limpa(String(r[0]).replace(/^\s*\d+\s*-\s*/, '')), ativa: limpa(r[1]).toUpperCase() === 'SIM', bandeira: limpa(r[2]), cnpj: limpa(r[3]), uf: limpa(r[4]), endereco: limpa(r[5]), cidade: titulo(r[6]), tipo: limpa(r[7]).toUpperCase(), cep: limpa(r[8]), supervisor: titulo(r[9]), classificacao: classif[c] || '' }; });
    return { base, contr, adq };
  },
  async aplicarImportacao({ base, contr, adq }) {
    let novas = 0, atualizadas = 0;
    for (const b of base) {
      const id = 'loja-' + b.codigo, atual = Repo.get('lojas', id);
      const doc = atual ? { ...atual, ...b } : { id, ...b, faturamentoMedio: null, horario: { semana: '', sabado: '', domingo: '' }, contrato: { indice: 'IGP-M', historico: [] }, despesas: { agua: {}, energia: {} }, seguros: [], origem: 'BASECADASTRO' };
      doc.contrato = { ...(doc.contrato || {}), statusDocumento: contr[b.codigo] || doc.contrato?.statusDocumento || '' };
      if (adq[b.codigo]) doc.adquirentes = adq[b.codigo];
      if (atual && !diffObjetos(atual, doc).length) continue;
      await Repo.salvar('lojas', id, doc, { modulo: 'lojas', rotulo: `${b.codigo} · ${b.nome} (importação)` });
      atual ? atualizadas++ : novas++;
      await sleep(120);
    }
    return { novas, atualizadas };
  },

  /* ---------------- eventos ---------------- */
  async acao(a, el) {
    const u = this.ui, id = el.dataset.id;
    switch (a) {
      case 'lj-abrir': u.sel = id; u.aba = 'dados'; u.calc = { pct: '', data: '' }; return App.render();
      case 'lj-voltar': u.sel = null; return App.render();
      case 'lj-dash': { const k = el.dataset.k, v = el.dataset.v; u[k] = u[k] === v ? '' : v; if (u.ativa === 'NAO') u.ativa = 'SIM'; return App.render(); }
      case 'lj-aba': u.aba = el.dataset.v; return App.render();
      case 'lj-nova': return this.abrirDados(null);
      case 'lj-editar-dados': return this.abrirDados(id);
      case 'lj-aplicar-reajuste': return this.aplicarReajuste(id);
      case 'lj-ficha': return this.ficha(id);
      case 'adq-novo': return this.abrirAdq(id, null);
      case 'adq-editar': return this.abrirAdq(id, +el.dataset.i);
      case 'adq-del': { if (!Auth.can('lojas.excluir')) return UI.toast('Excluir não está liberado para o seu acesso.'); const l = Repo.get('lojas', id), x = l.adquirentes[+el.dataset.i]; if (!(await UI.confirmar('Remover adquirente', `Remover ${esc(x.adquirente)} (${esc(x.codigoLogico)}) desta loja?`, 'Remover', true))) return; return Repo.salvar('lojas', id, { ...l, adquirentes: l.adquirentes.filter((_, i) => i !== +el.dataset.i) }, { modulo: 'lojas', rotulo: `${l.codigo} · ${l.nome} · adquirentes` }); }
      case 'ti-editar': return this.abrirTI(id);
      case 'desp-editar': return this.abrirDespesa(id, el.dataset.k);
      case 'doc-ia': return this.resumoIA(el);
      case 'doc-aplicar': return this.aplicarExtraidos(el);
      case 'lj-importar': {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xls';
        inp.onchange = async () => {
          try {
            const dados = await this.importar(inp.files[0]);
            if (!(await UI.confirmar('Importar BASECADASTRO', `Encontradas <b>${dados.base.length}</b> lojas e <b>${Object.values(dados.adq).flat().length}</b> registros de adquirentes. Dados fiscais, adquirentes e status de contrato serão atualizados; contratos, seguros e despesas já cadastrados são mantidos.`, 'Importar'))) return;
            UI.toast('Importando…'); const r = await this.aplicarImportacao(dados); UI.toast(`Importação concluída: ${r.novas} novas, ${r.atualizadas} atualizadas.`);
          } catch (e) { UI.toast('Falha na importação: ' + e.message); }
        };
        return inp.click();
      }
    }
  },
  async mudanca(a, el) {
    if (a === 'lj-filtro') { this.ui[el.dataset.k] = el.value; return App.render(); }
    if (a === 'doc-upload') return this.uploadDoc(el);
    if (a === 'lj-calc') { this.ui.calc[el.dataset.k] = el.value; return App.render(); }
  },
  entrada(a, el) {
    if (a === 'lj-busca') { this.ui.busca = el.value; App.render(); }
    if (a === 'lj-calc') { this.ui.calc[el.dataset.k] = el.value; App.render(); }
  },
};
