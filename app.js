/* =====================================================================
   APP — menu global, roteamento, auditoria, backup e inicialização
   ===================================================================== */
const MODULOS = [
  { id: 'pessoal', num: 'Módulo 1', titulo: 'Gestão de Pessoal', icon: 'pessoas', perm: 'pessoal.ver',
    desc: 'Equipe, jornada, banco de horas, férias e o PDI com matriz de competências e parecer para o colaborador.',
    stat: () => { const n = Repo.todos('funcionarios').filter(f => (f.status || 'Ativo') !== 'Desligado').length; return Repo.prontas.has('funcionarios') ? `${n} colaborador${n === 1 ? '' : 'es'}` : '…'; } },
  { id: 'lojas', num: 'Módulo 2', titulo: 'Gestão de Lojas', icon: 'loja', perm: 'lojas.ver',
    desc: 'Cadastro das filiais com painel por regional, UF e tipo, adquirentes e TEF, despesas fixas e os seguros de cada loja.',
    stat: () => {
      if (!Repo.prontas.has('lojas')) return '…';
      const a = Repo.todos('lojas').filter(x => x.ativa), alerta = Lojas.segurosProntos() ? a.filter(l => Lojas.segurosAlerta(l).length).length : 0;
      return `${a.length} lojas ativas${alerta ? ` · ${alerta} com seguro em alerta` : ''}`;
    } },
  { id: 'contratos', num: 'Módulo 3', titulo: 'Contratos de Locação e Outros', curto: 'Contratos', icon: 'contrato', perm: 'lojas.contratos.ver',
    desc: 'Repositório central de contratos e apólices: radar de ações renovatórias, radar de vigência dos seguros, leitor de documentos por IA e projeção de custos de ocupação.',
    stat: () => {
      if (!Contratos.pronto()) return '…';
      const p = RadarRenovatoria.painel(), s = RadarSeguros.painel();
      const partes = [p.cont.amarela ? `${p.cont.amarela} na janela da renovatória` : `${p.itens.length} contratos no radar`];
      if (s.cont.vermelha || s.cont.amarela) partes.push(`${s.cont.vermelha + s.cont.amarela} seguro(s) em alerta`);
      return partes.join(' · ');
    } },
  { id: 'fcx', num: 'Módulo 4', titulo: 'FCX · Fluxo de Caixa', curto: 'FCX', icon: 'caixa', perm: 'fcx.ver',
    desc: 'Projeção diária de caixa, orçamento, painel analítico e a DFC: extratos OFX cruzados com as premissas do FCX (realizado × previsto).',
    stat: () => 'receitas 2025 · saídas 2026' },
  { id: 'retaguarda', num: 'Módulo 5', titulo: 'Retaguarda Financeira', curto: 'Retaguarda', icon: 'retaguarda', perm: 'retaguarda.ver',
    desc: 'Operação das lojas: conciliação Credsystem, faltas de caixa, IEO com alerta por WhatsApp e auditoria de taxas e repasses das adquirentes.',
    stat: () => { if (!Repo.prontas.has('credsystem') || !Repo.prontas.has('faltas')) return '…'; const r = Retaguarda.rankingIEO(Retaguarda.mesAtual()).ranking, v = r.filter(x => x.zona === 'vermelha').length; return v ? `${v} loja${v > 1 ? 's' : ''} em zona vermelha` : `IEO médio ${Fmt.num(r.reduce((a, x) => a + x.pontos, 0) / (r.length || 1), 1)}`; } },
];
const ADMIN = [
  { id: 'acessos', titulo: 'Gestão de Acessos', curto: 'Acessos', icon: 'cadeado', perm: 'acessos.gerir', desc: 'Login por CPF dos funcionários do Módulo 1: ativar, resetar senha e definir a matriz Ler/Modificar/Excluir por módulo.' },
  { id: 'integracoes', titulo: 'Configurações de Integração', curto: 'Integrações', icon: 'tomada', perm: 'integracoes.gerir', desc: 'Banco de dados (Supabase), consulta de CNPJ, leitor de contratos e apólices por IA e armazenamento dos PDFs.' },
  { id: 'auditoria', titulo: 'Auditoria', icon: 'log', perm: 'auditoria.ver', desc: 'Log oculto de todas as alterações: quem fez, o que fez, data e hora. Usuários e perfis de acesso.' },
  { id: 'backup', titulo: 'Backup e dados', curto: 'Backup', icon: 'backup', perm: 'backup.exportar', desc: 'Cópia completa em arquivo (.json), planilhas (.xlsx) e restauração de backup.' },
];

const App = {
  rota: 'menu', _raf: null, navAberto: false,
  agendarRender() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); }); },
  ir(rota) {
    if (!Sessao.ativa) return Sessao.render(); // sem acesso validado: só a tela de entrada
    const todos = [...MODULOS, ...ADMIN];
    const m = todos.find(x => x.id === rota);
    if (m && (!Auth.can(m.perm) || m.emBreve)) rota = 'menu';
    if (this.rota === 'retaguarda' && rota !== 'retaguarda') Retaguarda.liberarAdq?.(); // saiu da Retaguarda (Módulo 5): libera a memória
    if (this.rota === 'contratos' && rota !== 'contratos') Contratos.pararVigia();
    this.rota = rota; this.navAberto = false; document.body.classList.remove('nav-open');
    try { history.replaceState(null, '', rota === 'menu' ? location.pathname : '#' + rota); } catch { }
    this.render(); window.scrollTo({ top: 0, behavior: 'smooth' });
    if (rota === 'auditoria') Aud.carregar();
  },
  render() {
    if (!Sessao.ativa) return Sessao.render();
    $('#topbar').innerHTML = this.topbar();
    const main = $('#main');
    const ativo = document.activeElement, idAtivo = ativo && ativo.id, sel = ativo && 'selectionStart' in ativo ? [ativo.selectionStart, ativo.selectionEnd] : null;
    const crumbs = this.rota === 'menu' ? '' : `<div class="crumbs"><button data-a="nav" data-r="menu">Painel de Gestão</button><span>/</span><span>${esc(([...MODULOS, ...ADMIN].find(m => m.id === this.rota) || {}).titulo || '')}</span></div>`;
    const tela = { menu: () => this.menu(), pessoal: () => Pessoal.render(), lojas: () => Lojas.render(), contratos: () => Contratos.render(), acessos: () => Acessos.render(), integracoes: () => Integracoes.render(), fcx: () => FCX.render(), retaguarda: () => Retaguarda.render(), auditoria: () => Aud.render(), backup: () => Bkp.render() }[this.rota];
    main.innerHTML = crumbs + (tela ? tela() : this.menu());
    UI.rotularTabelas(main);
    if (this.rota === 'retaguarda') Retaguarda.afterRender();
    if (this.rota === 'fcx') FCX.afterRender();
    if (this.rota === 'lojas') Lojas.afterRender();
    if (this.rota === 'contratos') Contratos.afterRender();
    if (this.rota === 'acessos') Acessos.afterRender();
    if (idAtivo) { const el = document.getElementById(idAtivo); if (el && el !== document.activeElement) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch { } } }
    FCX.sincronizar(); // o iframe do FCX vive fora de #main e não é recriado
  },
  /** Barra superior + navegação global. No celular/tablet (≤ 900px) a navegação vira gaveta (hambúrguer). */
  topbar() {
    const podeSimular = Auth.perfilReal === 'GESTOR';
    const itens = [{ id: 'menu', titulo: 'Início', icon: 'inicio' }, ...MODULOS, ...ADMIN].filter(m => m.id === 'menu' || Auth.can(m.perm));
    const seletor = podeSimular ? `<select data-a="perfil-sim" class="perfil-sel" aria-label="Visualizar como perfil">
          <option value="GESTOR" ${Auth.perfil === 'GESTOR' ? 'selected' : ''}>MASTER</option><option value="OPERACIONAL" ${Auth.perfil === 'OPERACIONAL' ? 'selected' : ''}>OPERACIONAL</option></select>`
        : `<span class="perfil-tag ${Auth.perfil}">${Auth.perfil === 'GESTOR' ? 'MASTER' : 'OPERACIONAL'}</span>`;
    return `<div class="topbar-inner">
      <button class="burger" data-a="nav-toggle" aria-label="${this.navAberto ? 'Fechar menu' : 'Abrir menu'}" aria-expanded="${this.navAberto}" aria-controls="mainnav">${this.navAberto ? ICON.fechar : ICON.menu}</button>
      <button class="brand" data-a="nav" data-r="menu" aria-label="Painel de Gestão — início"><img src="${LOGO_BRANCO}" alt="Esposende"><span class="sep"></span><span class="app">Painel de Gestão</span></button>
      <span class="spacer"></span>
      <span class="sync ${Cloud.nuvem ? '' : 'local'}" id="sync"><i></i><span id="syncTxt">${Cloud.nuvem ? 'salvo na nuvem' : 'salvo neste navegador'}</span></span>
      <div class="userchip">
        <div class="who"><b>${esc(Auth.nome)}</b><span>${Auth.simulado ? 'visualizando como' : 'perfil'}</span></div>
        ${seletor}
        ${Auth.avatar ? `<img src="${esc(Auth.avatar)}" alt="">` : ''}
        <button class="iconbtn sair" data-a="sess-sair" aria-label="Sair do painel" title="Sair do painel">${ICON.sair}</button>
      </div></div>
      <nav id="mainnav" class="mainnav ${this.navAberto ? 'open' : ''}" aria-label="Módulos">
        <div class="nav-inner">
          <div class="nav-user"><b>${esc(Auth.nome)}</b>${seletor}</div>
          ${itens.map(m => `<button class="${this.rota === m.id ? 'on' : ''}" data-a="nav" data-r="${m.id}" ${this.rota === m.id ? 'aria-current="page"' : ''} title="${esc(m.titulo)}" aria-label="${esc(m.titulo)}">${ICON[m.icon] || ''}<span class="nav-longo">${esc(m.titulo)}</span><span class="nav-curto" aria-hidden="true">${esc(m.curto || m.titulo)}</span></button>`).join('')}
        </div></nav>
      <div class="nav-scrim" data-a="nav-toggle" aria-hidden="true"></div>`;
  },
  menu() {
    const h = new Date().getHours(), saud = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
    const hoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const card = (m, extra = '') => {
      const ok = Auth.can(m.perm);
      if (!ok) return '';
      return `<button class="mod ${m.emBreve ? 'soon' : ''} ${extra}" ${m.emBreve ? 'aria-disabled="true"' : `data-a="nav" data-r="${m.id}"`}>
        <div class="head"><div class="ico">${ICON[m.icon]}</div>${m.emBreve ? '<span class="pill neutral">Em construção</span>' : ''}</div>
        <div><div class="eyebrow">${m.num || 'Administração'}</div><h3>${esc(m.titulo)}</h3></div>
        <p>${esc(m.desc)}</p>
        <div class="foot"><span class="stat">${m.stat ? m.stat() : ''}</span>${m.emBreve ? '' : '<span class="go">Abrir →</span>'}</div></button>`;
    };
    const admin = ADMIN.map(m => card(m, 'restrito')).join('');
    return `<div class="hello"><div><h1>${saud}, ${esc(Auth.nome.split(' ')[0])}.</h1><p>Escolha um módulo para começar.</p></div><span class="today">${hoje}</span></div>
      <div class="modules">${MODULOS.map(m => card(m)).join('')}</div>
      ${Auth.can('retaguarda.ieo.ver') && Repo.prontas.has('alertas') && Retaguarda.alertasAbertos().length ? `<div class="alerta-critico" role="alert" style="margin:18px 0 0"><div class="ic">${ICON.alerta}</div><div style="flex:1"><b>${Retaguarda.alertasAbertos().length} loja(s) em Zona Vermelha no IEO</b><div>A supervisão precisa tomar ciência.</div></div><button class="btn sm" data-a="nav-ieo">Ver IEO</button></div>` : ''}
      ${admin ? `<div class="section-label">Administração · somente GESTOR</div><div class="modules">${admin}</div>` : ''}
      ${!Cloud.nuvem && Auth.can('acessos.gerir') ? `<div class="note warn" style="margin-top:24px">Os dados estão sendo salvos neste navegador. Para várias pessoas usarem os mesmos dados (inclusive usuários e senhas), conecte o banco de dados compartilhado (Supabase): veja Configurações de Integração e o LEIA-ME.</div>` : ''}`;
  },
};

/* ---------------------------- Auditoria ---------------------------- */
const Aud = {
  ui: { aba: 'log', usuario: '', modulo: '', acao: '', busca: '', dias: 31 }, eventos: null, nomes: {}, erro: '', usuarios: [],
  async carregar() {
    this.eventos = null; this.erro = ''; App.render();
    try {
      this.eventos = await Audit.carregar({ dias: this.ui.dias });
      this.usuarios = await Cloud.adapter.list('presenca').catch(() => []);
      const ids = [...new Set([...this.eventos.map(e => e.uid), ...this.usuarios.map(u => u.id)])];
      this.nomes = await Auth.nomes(ids);
    } catch (e) { this.erro = e.message || String(e); this.eventos = []; }
    App.render();
  },
  filtrados() {
    const u = this.ui, q = u.busca.toLowerCase();
    return (this.eventos || []).filter(e => (!u.usuario || e.uid === u.usuario) && (!u.modulo || e.modulo === u.modulo) && (!u.acao || e.acao === u.acao)
      && (!q || [e.rotulo, e.entidadeId, e.detalhe, ...(e.mudancas || []).map(m => m.campo + m.de + m.para)].join(' ').toLowerCase().includes(q)));
  },
  render() {
    const u = this.ui;
    const tabs = `<div class="tabs"><button class="${u.aba === 'log' ? 'on' : ''}" data-a="aud-aba" data-v="log">Log de alterações</button><button class="${u.aba === 'usuarios' ? 'on' : ''}" data-a="aud-aba" data-v="usuarios">Usuários e permissões</button></div>`;
    const head = `<div class="page-head"><div><h1>Auditoria</h1><p>Registro oculto e permanente de cada gravação feita no painel. Visível apenas para o perfil GESTOR.</p></div>
      <div class="row"><button class="btn sec" data-a="aud-recarregar">Atualizar</button>${this.eventos?.length ? '<button class="btn" data-a="aud-exportar">Exportar (.xlsx)</button>' : ''}</div></div>`;
    if (u.aba === 'usuarios') return head + tabs + this.renderUsuarios();
    if (this.eventos == null) return head + tabs + '<div class="panel"><p class="muted">Carregando registros…</p></div>';
    const lista = this.filtrados(), mods = [...new Set(this.eventos.map(e => e.modulo))].sort(), acs = [...new Set(this.eventos.map(e => e.acao))].sort();
    const opt = (k, arr, rot) => `<div class="field"><label class="lbl" for="aud_${k}">${rot}</label><select id="aud_${k}" data-a="aud-filtro" data-k="${k}"><option value="">Todos</option>${arr.map(([v, l]) => `<option value="${esc(v)}" ${v === u[k] ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
    const cor = { criou: 'ok', alterou: 'info', excluiu: 'bad', emitiu: 'neutral' };
    return head + tabs + `<div class="panel">
      <div class="toolbar">
        <div class="field grow"><label class="lbl" for="audBusca">Buscar</label><input id="audBusca" type="search" value="${esc(u.busca)}" placeholder="Registro, campo, valor…" data-a="aud-busca"></div>
        ${opt('usuario', Object.entries(this.nomes), 'Usuário')}${opt('modulo', mods.map(m => [m, m]), 'Módulo')}${opt('acao', acs.map(a => [a, a]), 'Ação')}
        <div class="field"><label class="lbl" for="audDias">Período</label><select id="audDias" data-a="aud-dias">${[[7, '7 dias'], [31, '31 dias'], [90, '90 dias'], [365, '12 meses']].map(([v, l]) => `<option value="${v}" ${v === u.dias ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      ${this.erro ? `<div class="note warn">${esc(this.erro)}</div>` : ''}
      ${lista.length ? `<div class="tbl-wrap"><table><thead><tr><th>Data e hora</th><th>Quem fez</th><th>O que fez</th><th>Registro</th><th>Alterações</th></tr></thead><tbody>
        ${lista.slice(0, 500).map(e => `<tr><td class="mono" style="white-space:nowrap">${Fmt.dataHora(e.ts)}</td>
          <td><div class="cell-main">${esc(this.nomes[e.uid] || e.uid)}</div><span class="perfil-tag ${e.perfil}" style="font-size:9.5px">${esc(e.perfil)}</span></td>
          <td><span class="pill ${cor[e.acao] || 'neutral'}">${esc(e.acao)}</span><div class="cell-sub">${esc(e.modulo)}</div></td>
          <td>${esc(e.rotulo)}${e.detalhe ? `<div class="cell-sub">${esc(e.detalhe)}</div>` : ''}</td>
          <td>${(e.mudancas || []).length ? `<details class="log"><summary>${e.mudancas.length} campo(s)</summary>${e.mudancas.map(m => `<div class="chg"><b>${esc(m.campo)}</b>: ${esc(m.de)} → ${esc(m.para)}</div>`).join('')}</details>` : '<span class="hint">—</span>'}</td></tr>`).join('')}
      </tbody></table></div><p class="hint" style="margin-top:8px">${lista.length} evento(s)${lista.length > 500 ? ' · exibindo os 500 mais recentes (exporte para ver todos)' : ''}</p>`
        : '<div class="empty">Nenhum evento no período.</div>'}</div>`;
  },
  renderUsuarios() {
    const perfis = ['GESTOR', 'OPERACIONAL'];
    return `<div class="grid g2">
      <div class="panel"><h2>Quem acessa o painel</h2><p class="sub">Perfis e permissões de cada pessoa são definidos na <b>Gestão de Acessos</b> (Master e Operacional com matriz por módulo).</p>
        ${this.usuarios.length ? `<table><thead><tr><th>Usuário</th><th>Perfil</th><th>Último acesso</th></tr></thead><tbody>${this.usuarios.map(p => `<tr><td>${esc(this.nomes[p.id] || p.id)}</td><td><span class="perfil-tag ${p.perfil}" style="border:1px solid var(--line)">${esc(p.perfil)}</span></td><td class="mono">${Fmt.data(p.ultimoDia)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Ninguém registrado ainda.</div>'}</div>
      <div class="panel"><h2>Matriz de permissões</h2><p class="sub">Estrutura pronta para o detalhamento. Edite <span class="mono">PERMISSOES</span> no código ou grave <span class="mono">config/permissoes</span>.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Permissão</th>${perfis.map(p => `<th style="text-align:center">${p}</th>`).join('')}</tr></thead><tbody>
        ${PERMISSOES._catalogo.map(perm => `<tr><td class="mono" style="font-size:12px">${perm}</td>${perfis.map(p => { const l = Auth.matriz[p] || []; const ok = l.some(x => x === '*' || x === perm || (x.endsWith('.*') && perm.startsWith(x.slice(0, -1)))); return `<td style="text-align:center">${ok ? `<span class="pill ok">${ICON.ok}</span>` : '<span class="hint">—</span>'}</td>`; }).join('')}</tr>`).join('')}
        </tbody></table></div></div></div>`;
  },
  async exportar() {
    const XLSX = await Libs.xlsx();
    const linhas = this.filtrados().flatMap(e => (e.mudancas?.length ? e.mudancas : [{}]).map(m => ({ 'Data/hora': Fmt.dataHora(e.ts), Usuário: this.nomes[e.uid] || e.uid, Perfil: e.perfil, Módulo: e.modulo, Ação: e.acao, Registro: e.rotulo, Campo: m.campo || '', De: m.de || '', Para: m.para || '' })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), 'Auditoria');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    await Documento.baixarArquivo(`auditoria_${Datas.hojeISO()}.xlsx`, new Blob([buf]));
  },
  acao(a, el) {
    if (a === 'aud-aba') { this.ui.aba = el.dataset.v; return App.render(); }
    if (a === 'aud-recarregar') return this.carregar();
    if (a === 'aud-exportar') return this.exportar();
  },
  mudanca(a, el) {
    if (a === 'aud-filtro') { this.ui[el.dataset.k] = el.value; App.render(); }
    if (a === 'aud-dias') { this.ui.dias = +el.value; this.carregar(); }
  },
  entrada(a, el) { if (a === 'aud-busca') { this.ui.busca = el.value; App.render(); } },
};

/* ------------------------------ Backup ------------------------------ */
const Bkp = {
  // v15: todas as coleções de negócio (usuários, chaves de integração e auditoria ficam fora)
  COLECOES: ['lojas', 'funcionarios', 'pdi', 'salarios', 'config', 'fcx', 'rh_cargos', 'rh_centros', 'contratos_locacao', 'seguros_vigencia', 'aluguel_projecoes',
    'credsystem', 'faltas', 'caixas', 'ieo_ocorrencias', 'ieo_fechamentos', 'ieo_laudos', 'alertas', 'adq_taxas', 'adq_auditorias', 'adq_excecoes', 'contasBancarias', 'extratos', 'dfc'],
  render() {
    const cont = c => Repo.cols[c] ? Repo.todos(c).length : '—';
    return `<div class="page-head"><div><h1>Backup e dados</h1><p>Guarde uma cópia completa dos dados em arquivo e restaure quando precisar.</p></div></div>
      <div class="grid g3" style="margin-bottom:16px">
        <div class="kpi"><div class="k">Armazenamento</div><div class="v" style="font-size:18px">${esc(Cloud.adapter.rotulo)}</div><div class="d">${Cloud.nuvem ? 'sincronizado em tempo real' : 'apenas neste navegador'}</div></div>
        <div class="kpi"><div class="k">Lojas · colaboradores</div><div class="v">${cont('lojas')} · ${cont('funcionarios')}</div><div class="d">registros no cadastro</div></div>
        <div class="kpi"><div class="k">Avaliações PDI</div><div class="v">${Repo.todos('pdi').reduce((a, p) => a + (p.avaliacoes || []).length, 0)}</div><div class="d">em ${cont('pdi')} colaboradores</div></div>
      </div>
      <div class="grid g2">
        <div class="panel"><h2>Backup completo (.json)</h2><p class="sub">Todas as coleções: lojas, equipe, PDI${Auth.can('pessoal.salario.ver') ? ', salários' : ''}, contratos e apólices, FCX e DFC, Retaguarda e configurações (usuários e chaves de API ficam fora). Guarde em local seguro (contém dados pessoais).</p>
          <label class="check"><input type="checkbox" id="bkpLog"> Incluir log de auditoria</label>
          <div class="row" style="margin-top:14px"><button class="btn" data-a="bkp-json">Baixar backup completo</button></div></div>
        <div class="panel"><h2>Planilhas (.xlsx)</h2><p class="sub">Lojas, adquirentes e equipe em abas separadas, para conferência no Excel.${Auth.can('pessoal.salario.ver') ? ' Salários só entram se você marcar.' : ''}</p>
          ${Auth.can('pessoal.salario.ver') ? '<label class="check"><input type="checkbox" id="bkpSal"> Incluir salários</label>' : ''}
          <div class="row" style="margin-top:14px"><button class="btn sec" data-a="bkp-xlsx">Baixar planilhas</button></div></div>
      </div>
      ${Auth.can('backup.restaurar') ? `<div class="panel"><h2>Restaurar backup</h2><p class="sub">Grava de volta os registros de um arquivo .json gerado aqui. Registros com o mesmo código são substituídos; o log de auditoria nunca é sobrescrito. A restauração fica registrada no log.</p>
        <label class="btn danger" style="cursor:pointer">Escolher arquivo de backup<input type="file" accept=".json,application/json" hidden data-a="bkp-restaurar"></label></div>` : ''}
      <div class="panel"><h2>Rotina recomendada</h2><p class="sub" style="margin-bottom:0">Backup completo toda sexta-feira e antes de importações grandes; mantenha as 8 últimas cópias numa pasta com acesso restrito (ex.: OneDrive/SharePoint da diretoria).</p></div>`;
  },
  async json() {
    const out = { app: 'painel-gestao-esposende', versao: 1, geradoEm: new Date().toISOString(), geradoPor: Auth.id, colecoes: {} };
    for (const c of this.COLECOES) { if (c === 'salarios' && !Auth.can('pessoal.salario.ver')) continue; out.colecoes[c] = await Cloud.adapter.list(c).catch(() => []); }
    if ($('#bkpLog')?.checked) out.auditoria = await Audit.carregar({ dias: 400 });
    const ok = await Documento.baixarArquivo(`backup_painel_esposende_${Datas.hojeISO()}.json`, JSON.stringify(out));
    if (ok) Audit.registrar({ modulo: 'backup', acao: 'exportou', entidade: 'backup', entidadeId: Datas.hojeISO(), rotulo: 'Backup completo', mudancas: Object.entries(out.colecoes).map(([k, v]) => ({ campo: k, de: '', para: v.length + ' registros' })) });
  },
  async xlsx() {
    const XLSX = await Libs.xlsx(), sal = $('#bkpSal')?.checked;
    const lojas = Repo.todos('lojas').sort((a, b) => a.codigo.localeCompare(b.codigo));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lojas.map(l => ({ Código: l.codigo, Loja: l.nome, Ativa: l.ativa ? 'SIM' : 'NÃO', Bandeira: l.bandeira, Tipo: l.tipo, CNPJ: l.cnpj, Endereço: l.endereco, Cidade: l.cidade, UF: l.uf, CEP: l.cep, Supervisor: l.supervisor, 'Faturamento médio': l.faturamentoMedio, Aluguel: l.contrato?.valorAluguel, Índice: l.contrato?.indice, 'Início contrato': l.contrato?.inicio, 'Fim contrato': l.contrato?.fim, 'Doc. contrato': l.contrato?.statusDocumento }))), 'Lojas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lojas.flatMap(l => (l.adquirentes || []).map(a => ({ Código: l.codigo, Loja: l.nome, Adquirente: a.adquirente, Tipo: a.tipo, Posição: a.posicao, EC: a.ec, 'Nº lógico': a.codigoLogico, 'CNPJ TEF': a.cnpjTef, Concentradora: a.concentradora, Integradora: a.integradora })))), 'Adquirentes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(Repo.todos('funcionarios').map(f => ({ Nome: f.nome, Matrícula: f.matricula, Cargo: f.cargo, Lotação: Pessoal.lotacaoNome(f), Admissão: f.admissao, Situação: f.status, Escala: f.escala, Folgas: (f.folgas || []).join(', '), 'Banco de horas': f.bancoHoras, ...(sal ? { Salário: Repo.get('salarios', f.id)?.valor } : {}) }))), 'Equipe');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    if (await Documento.baixarArquivo(`painel_esposende_${Datas.hojeISO()}.xlsx`, new Blob([buf]))) Audit.registrar({ modulo: 'backup', acao: 'exportou', entidade: 'planilhas', entidadeId: Datas.hojeISO(), rotulo: 'Planilhas' + (sal ? ' (com salários)' : ''), mudancas: [] });
  },
  async restaurar(file) {
    let dados; try { dados = JSON.parse(await file.text()); } catch { return UI.toast('Arquivo inválido.'); }
    if (dados.app !== 'painel-gestao-esposende') return UI.toast('Este arquivo não é um backup do Painel de Gestão.');
    const resumo = Object.entries(dados.colecoes || {}).map(([k, v]) => `${k}: ${v.length}`).join(' · ');
    if (!(await UI.confirmar('Restaurar backup', `Backup de ${Fmt.dataHora(dados.geradoEm)}.<br>${esc(resumo)}<br><br>Os registros atuais com o mesmo código serão substituídos.`, 'Restaurar', true))) return;
    UI.toast('Restaurando…'); let n = 0;
    for (const [col, docs] of Object.entries(dados.colecoes || {})) {
      if (!this.COLECOES.includes(col)) continue;
      if (Cloud.adapter.setLote) { await Cloud.adapter.setLote(col, docs); n += docs.length; UI.toast(`Restaurando… ${n} registros`); continue; }
      for (const d of docs) { const { id, ...resto } = d; await Cloud.adapter.set(col + '/' + id, resto); n++; if (n % 20 === 0) await sleep(200); }
    }
    await Audit.registrar({ modulo: 'backup', acao: 'restaurou', entidade: 'backup', entidadeId: dados.geradoEm, rotulo: 'Restauração de backup', mudancas: [{ campo: 'registros', de: '', para: String(n) }] });
    UI.toast(`Backup restaurado: ${n} registros.`);
  },
  acao(a) { if (a === 'bkp-json') return this.json(); if (a === 'bkp-xlsx') return this.xlsx(); },
  mudanca(a, el) { if (a === 'bkp-restaurar' && el.files[0]) return this.restaurar(el.files[0]); },
};

/* --------------------------- Eventos globais --------------------------- */
const ROTEADOR = [
  [/^(pes|func|sal|pdi|plano|folha)-/, () => Pessoal], [/^rt-/, () => Retaguarda], [/^(fcx|fd)-/, () => FCX], [/^(lj|adq|ti|desp|seg|doc)-/, () => Lojas], [/^ct-/, () => Contratos], [/^alg-/, () => ProjecaoOcupacao],
  [/^aud-/, () => Aud], [/^bkp-/, () => Bkp], [/^sess-/, () => Sessao], [/^acc-/, () => Acessos], [/^int-/, () => Integracoes],
];
const alvo = a => (ROTEADOR.find(([re]) => re.test(a)) || [])[1]?.();
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return;
  const a = el.dataset.a;
  if (a === 'nav') return App.ir(el.dataset.r);
  if (a === 'nav-ieo') { Retaguarda.ui.aba = 'ieo'; return App.ir('retaguarda'); }
  if (a === 'nav-toggle') { App.navAberto = !App.navAberto; document.body.classList.toggle('nav-open', App.navAberto); $('#topbar').innerHTML = App.topbar(); return; }
  const m = alvo(a); if (m && m.acao) Promise.resolve(m.acao(a, el, e)).catch(err => UI.toast(err.message || String(err)));
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-a]'); if (!el) return; const a = el.dataset.a;
  if (a === 'perfil-sim') { Auth.simular(el.value); UI.toast('Visualizando como ' + el.value); return App.ir(App.rota); }
  const m = alvo(a); if (m && m.mudanca) Promise.resolve(m.mudanca(a, el)).catch(err => UI.toast(err.message || String(err)));
});
document.addEventListener('input', e => {
  const el = e.target.closest('[data-a]'); if (!el) return; const m = alvo(el.dataset.a);
  if (m && m.entrada) { clearTimeout(App._deb); App._deb = setTimeout(() => m.entrada(el.dataset.a, el), 180); }
});

/* ------------------------------ Inicialização ------------------------------ */
/**
 * Inicialização em duas fases (v14):
 *   1) conecta ao armazenamento e mostra a TELA DE ENTRADA (login por CPF) — só usuarios e funcionarios são
 *      lidos para conferir o login; nenhum módulo, menu ou outro dado é carregado;
 *   2) com o login validado (Sessao.abrir) assina as coleções e desenha o painel (App.iniciarPainel).
 */
App.iniciarPainel = function () {
  ['lojas', 'funcionarios', 'pdi', 'config', 'rh_cargos', 'rh_centros', 'credsystem', 'faltas', 'caixas', 'ieo_ocorrencias', 'ieo_fechamentos', 'ieo_laudos', 'alertas'].forEach(c => Repo.assinar(c));
  if (Auth.can('lojas.ver')) Repo.assinar('seguros_vigencia'); // espelho sem valores (validade das apólices)
  if (Auth.can('lojas.contratos.ver')) ['contratos_locacao', 'aluguel_projecoes'].forEach(c => Repo.assinar(c));
  if (Auth.can('retaguarda.adq.ver')) ['adq_taxas', 'adq_auditorias', 'adq_excecoes'].forEach(c => Repo.assinar(c));
  if (Auth.can('fcx.dfc.ver')) ['contasBancarias', 'extratos', 'dfc'].forEach(c => Repo.assinar(c));
  if (Auth.can('pessoal.salario.ver')) Repo.assinar('salarios');
  if (Auth.can('acessos.gerir') || Auth.can('auditoria.ver')) Repo.assinar('usuarios');
  if (Auth.can('integracoes.gerir')) Repo.assinar('integracoes');
  Integracoes.iniciar(); // liga IA, CNPJ e armazenamento conforme Configurações de Integração
  Presenca.tocar();
  const h = (location.hash || '').slice(1);
  App.ir([...MODULOS, ...ADMIN].some(m => m.id === h) ? h : 'menu');
  if (Auth.can('fcx.ver')) setTimeout(() => { if (Sessao.ativa) FCX.preparar(); }, 1200); // cache + iframe do FCX em segundo plano
  ContratosManutencao._feito = false; ContratosManutencao.iniciar(); // GESTOR: migra apólices antigas das lojas e confere o espelho de vigência
};
(async function iniciar() {
  $('#main').innerHTML = '<div class="panel" style="margin-top:30px"><p class="muted" style="margin:0">Conectando ao Painel de Gestão…</p></div>';
  try { await Cloud.init(); }
  catch (e) { $('#main').innerHTML = `<div class="panel" style="margin-top:30px"><h2>Não foi possível conectar ao banco de dados</h2><p class="muted" style="margin:0">${esc(e.message || String(e))}. Verifique a conexão e o arquivo config.js da instalação.</p></div>`; return; }
  await Auth.init();
  Sessao.iniciar();
})();
