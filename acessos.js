/* =====================================================================
   v14/v15 — LOGIN (CPF + senha) e GESTÃO DE ACESSOS
   v15: com o banco compartilhado (Supabase) o login usa o Supabase Auth (IdSupabase, nuvem.js) e as
   regras do banco (RLS) fazem o corte de verdade no servidor; sem ele, vale o modelo local abaixo (IdLocal).
   Modelo: login independente, só no frontend (decisão do Renato, 01/10/2026). A proteção externa é a
   rede corporativa (intranet). As senhas são guardadas com sal + SHA-256 em várias rodadas (Senha, core.js):
   isso é controle organizacional, não segurança criptográfica de servidor.

   Camadas:
     5 Repositório → usuarios/<usr-…>  { perfil 'MASTER'|'OPERACIONAL', funcionarioId? (Módulo 1),
                                         nome?/cpf? (só no Master avulso da configuração inicial),
                                         permissoes{pdi,lojas,contratos,fcx,retaguarda}, ativo,
                                         senha{alg,sal,hash}, trocarSenha, ultimoAcesso }
                     Usuário = CPF do funcionário (só dígitos); senha inicial = o próprio CPF.
     6 Serviços    → Sessao (antes do login lê SÓ usuarios e funcionarios; nenhum menu, módulo ou outra
                              coleção é carregado; depois do login vigia o próprio usuário e o funcionário)
     7 UI          → Sessao.render (tela de entrada, troca obrigatória, configuração inicial)
                     Acessos (tela "Gestão de Acessos", só Master)
   Bloqueios: funcionário Desligado/Inativo no Módulo 1, usuário desativado ou removido → o CPF deixa de
   entrar e a sessão aberta é encerrada na hora.
   ===================================================================== */
const SESSAO_CHAVE = 'esp-painel:sessao', SESSAO_HORAS = 12, TENTATIVAS_MAX = 5, BLOQUEIO_SEG = 60;

const Sessao = {
  ativa: false, _unsubs: [], _ultimo: null, _falhas: 0, _bloqueadoAte: 0, _pendente: null,
  ler() { try { return JSON.parse(sessionStorage.getItem(SESSAO_CHAVE) || 'null'); } catch { return null; } },
  gravar(o) { try { sessionStorage.setItem(SESSAO_CHAVE, JSON.stringify(o)); } catch { /* sessão só em memória */ } },
  limpar() { try { sessionStorage.removeItem(SESSAO_CHAVE); } catch { } },
  desligado(f) { return !!f && ['DESLIGADO', 'INATIVO'].includes(String(f.status || 'Ativo').trim().toUpperCase()); },
  /** Provedor de identidade: Supabase Auth (banco compartilhado) ou local (usuarios com senha em hash). */
  get prov() { return Cloud.adapter?.identidade === 'supabase' ? IdSupabase : IdLocal; },
  /** CPF do usuário: o do funcionário vinculado (Módulo 1) ou o do Master avulso. */
  cpfDe(u, f) { return CPF.limpar(f?.cpf || u?.cpf || ''); },
  situacao(u, f) {
    if (!u) return 'revogado';
    if (u.ativo === false) return 'desativado';
    if (u.funcionarioId && !f) return 'sem_funcionario';
    if (this.desligado(f)) return 'desligado';
    return 'ok';
  },
  localizar(base, cpf) {
    const d = CPF.limpar(cpf);
    for (const u of base.usuarios) { const f = u.funcionarioId ? base.funcionarios.find(x => x.id === u.funcionarioId) : null; if (d && this.cpfDe(u, f) === d) return { u, f }; }
    return null;
  },

  /** Primeira tela: sessão válida desta aba entra direto (revalidando); senão, login ou configuração inicial. */
  async iniciar() {
    this.render({ carregando: true });
    try { if (!(await this.prov.temMaster())) return this.render({ setup: true }); }
    catch (e) { return this.render({ erro: 'Não foi possível conectar à base de usuários: ' + (e.message || e) }); }
    const r = await this.prov.restaurar().catch(() => null);
    if (r) return this.abrir(r.u, r.f, r.s);
    this.limpar(); this.render({});
  },
  async entrar(cpf, senha) {
    if (Date.now() < this._bloqueadoAte) return this.render({ erro: `Muitas tentativas. Aguarde ${Math.ceil((this._bloqueadoAte - Date.now()) / 1000)} s.`, cpf });
    this.render({ carregando: true, cpf });
    let achado; try { achado = await this.prov.autenticar(cpf, senha); } catch (e) { return this.render({ erro: e.message || String(e), cpf }); }
    // mensagem única para CPF inexistente ou senha errada (não revela quais CPFs têm acesso)
    if (!achado) {
      if (++this._falhas >= TENTATIVAS_MAX) { this._falhas = 0; this._bloqueadoAte = Date.now() + BLOQUEIO_SEG * 1000; }
      return this.render({ erro: 'CPF ou senha incorretos.', cpf });
    }
    this._falhas = 0;
    const { u, f, sit } = achado;
    if (sit !== 'ok') return this.render({ motivo: sit, cpf });
    // troca obrigatória: primeiro acesso, senha resetada ou senha ainda igual ao CPF
    if (u.trocarSenha || CPF.limpar(senha) === CPF.limpar(cpf)) { this._pendente = { u, f, cpf: CPF.limpar(cpf) }; return this.render({ troca: true }); }
    return this.abrir(u, f);
  },
  async trocarSenha(nova, conf) {
    const p = this._pendente; if (!p) return this.render({});
    const prob = Senha.problemas(nova, p.cpf);
    if (nova !== conf) return this.render({ troca: true, erro: 'A confirmação não confere com a nova senha.' });
    if (prob.length) return this.render({ troca: true, erro: 'A nova senha precisa ' + prob.join(', ') + '.' });
    this.render({ carregando: true });
    let u; try { u = await this.prov.salvarSenha(p, nova); } catch (e) { return this.render({ troca: true, erro: e.message || String(e) }); }
    this._pendente = null;
    const f = p.f || (u.funcionarioId ? await Cloud.adapter.get('funcionarios/' + u.funcionarioId).catch(() => null) : null);
    return this.abrir(u, f);
  },
  /** Primeira instalação: cria o Master (nome, CPF e senha forte). */
  async configurar(nome, cpf, senha, conf) {
    const d = CPF.limpar(cpf), prob = Senha.problemas(senha, d);
    const erro = !String(nome).trim() ? 'Informe o nome.' : !CPF.valido(d) ? 'CPF inválido.' : senha !== conf ? 'A confirmação não confere com a senha.' : prob.length ? 'A senha precisa ' + prob.join(', ') + '.' : '';
    if (erro) return this.render({ setup: true, erro, nome, cpf });
    this.render({ carregando: true });
    let r; try { r = await this.prov.criarMaster(String(nome).trim(), d, senha); } catch (e) { return this.render({ setup: true, erro: e.message || String(e), nome, cpf }); }
    return this.abrir(r.u, r.f || null);
  },
  async abrir(u, f, sessaoExistente = null) {
    const s = sessaoExistente || { uid: u.id, exp: Date.now() + SESSAO_HORAS * 3600e3 };
    if (!sessaoExistente) u = await this.prov.registrarAcesso(u);
    this.gravar(s);
    Auth.aplicarUsuario(u, f);
    await Auth.carregarConfig();
    if (u.perfil !== 'MASTER') Auth.aplicarUsuario(u, f); // a matriz do usuário prevalece sobre config/permissoes
    this.ativa = true; this.vigiar(u, f);
    App.iniciarPainel();
  },
  /** Desligamento automático e permissões ao vivo: o próprio usuário e o funcionário ficam sob observação. */
  vigiar(u0, f0) {
    this.pararVigia();
    let u = u0, f = f0;
    const reavaliar = () => {
      if (!this.ativa) return;
      const sit = this.situacao(u, f); if (sit !== 'ok') return this.encerrar(sit);
      if (u.trocarSenha) return this.encerrar('resetada'); // senha resetada pelo Master: precisa criar outra
      const mudou = JSON.stringify([u.perfil, u.permissoes]) !== JSON.stringify([Auth.usuario?.perfil, Auth.usuario?.permissoes]);
      Auth.usuario = u;
      if (mudou) { Auth.aplicarUsuario(u, f); UI.toast('Suas permissões foram atualizadas pelo Master.'); App.render(); }
    };
    const w = Cloud.adapter.watchDoc.bind(Cloud.adapter);
    this._unsubs.push(w('usuarios/' + u.id, d => { u = d; reavaliar(); }));
    if (u.funcionarioId) this._unsubs.push(w('funcionarios/' + u.funcionarioId, d => { if (d || !Cloud.nuvem) { f = d; reavaliar(); } }));
    // banco compartilhado: o servidor corta os dados na hora; a tela confere a situação a cada 30 s
    // (um desligamento tira do usuário a leitura do próprio funcionário, então o evento pode não chegar)
    if (Cloud.nuvem) {
      const t = setInterval(async () => {
        if (!this.ativa) return; const sit = await this.prov.situacao().catch(() => null);
        if (sit && sit !== 'ok') return this.encerrar(sit);
      }, 30000);
      this._unsubs.push(() => clearInterval(t));
    }
  },
  pararVigia() { this._unsubs.forEach(x => { try { x(); } catch { } }); this._unsubs = []; },
  /** Fecha o painel: solta assinaturas, caches e arquivos em memória e volta para a tela de entrada. */
  encerrar(motivo = 'saiu') {
    this.ativa = false; this.limpar(); this.pararVigia(); this._pendente = null;
    this.prov.sair(); try { Cloud.adapter.reset?.(); } catch { }
    try { Retaguarda.liberarAdq?.(); Contratos.pararVigia?.(); } catch { }
    Repo._unsubs.forEach(x => { try { x(); } catch { } }); Repo._unsubs = []; Repo.cols = {}; Repo.prontas.clear(); Repo.rev++;
    try { const h = $('#fcxHost'); if (h) { h.innerHTML = ''; h.hidden = true; } FCX._cache = null; FCX._cacheProm = null; } catch { }
    const mod = $('#modais'); if (mod) mod.innerHTML = ''; document.body.classList.remove('modal-aberto', 'nav-open', 'fcx-on');
    Auth.limpar(); App.rota = 'menu'; Cloud.caps.sample = null; Cloud.caps.assets = null;
    try { history.replaceState(null, '', location.pathname); } catch { }
    this.render({ motivo });
  },

  /* ---------------- telas ---------------- */
  MSG: {
    desativado: 'Seu acesso está desativado. Procure o seu gestor.',
    desligado: 'Acesso encerrado: o seu cadastro está como desligado no Módulo 1. Procure o seu gestor.',
    sem_funcionario: 'O funcionário vinculado a este acesso não foi encontrado. Procure o seu gestor.',
    revogado: 'O seu acesso foi removido. Procure o seu gestor.',
    resetada: 'Sua senha foi redefinida pelo gestor. Entre com o CPF para criar uma nova.',
    saiu: 'Você saiu do painel.',
  },
  /** Sem argumento (ex.: App.render chamado por um evento atrasado) repete a última tela mostrada. */
  render(r) {
    if (r === undefined) r = this._ultimo || {}; else this._ultimo = r;
    $('#topbar').innerHTML = '';
    const marca = `<div class="login-marca"><img src="${LOGO_NAVY}" alt="Esposende"><span>Painel de Gestão</span></div>`;
    const erro = r.erro ? `<div class="login-erro" role="alert">${esc(r.erro)}</div>` : r.motivo && this.MSG[r.motivo] ? `<div class="login-erro ${r.motivo === 'saiu' ? 'info' : ''}" role="alert">${esc(this.MSG[r.motivo])}</div>` : '';
    const senhaCampo = (nome, rot, auto) => `<div class="field"><label class="lbl" for="lg_${nome}">${rot}</label><div class="login-senha"><input id="lg_${nome}" name="${nome}" type="password" autocomplete="${auto}" required><button type="button" class="iconbtn" data-ver-senha aria-label="Mostrar senha">${ICON.olho}</button></div></div>`;
    const regra = '<p class="hint" style="margin:0">Mínimo de 8 caracteres, com letra maiúscula, minúscula e número, diferente do CPF.</p>';
    let corpo;
    if (r.carregando) corpo = `<h1>Entrar no painel</h1><div class="login-spin" role="status" aria-label="Carregando"></div>`;
    else if (r.setup) corpo = `<h1>Configuração inicial</h1><p class="login-sub">Nenhum usuário Master cadastrado. Crie o primeiro acesso Master: ele ativa os funcionários e define as permissões na Gestão de Acessos.</p>${erro}
      <form class="login-form" data-form="setup" novalidate>
        <div class="field"><label class="lbl" for="lg_nome">Nome</label><input id="lg_nome" name="nome" value="${esc(r.nome || '')}" autocomplete="name" required></div>
        <div class="field"><label class="lbl" for="lg_cpf">CPF</label><input id="lg_cpf" name="cpf" value="${esc(r.cpf || '')}" inputmode="numeric" autocomplete="username" placeholder="000.000.000-00" data-cpf required></div>
        ${senhaCampo('senha', 'Senha', 'new-password')}${senhaCampo('conf', 'Confirmar senha', 'new-password')}${regra}
        <button class="btn" type="submit">Criar acesso Master e entrar</button></form>`;
    else if (r.troca) corpo = `<h1>Crie a sua senha</h1><p class="login-sub">Primeiro acesso (ou senha redefinida pelo gestor): defina uma senha pessoal para continuar.</p>${erro}
      <form class="login-form" data-form="troca" novalidate>${senhaCampo('nova', 'Nova senha', 'new-password')}${senhaCampo('conf', 'Confirmar nova senha', 'new-password')}${regra}
        <button class="btn" type="submit">Salvar senha e entrar</button><button class="btn ghost" type="button" data-a="sess-cancelar">Cancelar</button></form>`;
    else corpo = `<h1>Entrar no painel</h1><p class="login-sub">Use o seu CPF. No primeiro acesso, a senha também é o CPF.</p>${erro}
      <form class="login-form" data-form="login" novalidate>
        <div class="field"><label class="lbl" for="lg_cpf">CPF</label><input id="lg_cpf" name="cpf" value="${esc(r.cpf || '')}" inputmode="numeric" autocomplete="username" placeholder="000.000.000-00" data-cpf required></div>
        ${senhaCampo('senha', 'Senha', 'current-password')}
        <button class="btn" type="submit">Entrar</button></form>
      <p class="login-rodape">Esqueceu a senha? Procure o seu gestor.</p>`;
    $('#main').innerHTML = `<section class="login" aria-label="Acesso ao Painel de Gestão"><div class="login-card">${marca}${corpo}</div></section>`;
    ((r.cpf && $('#lg_senha')) || $('#main .login-form input'))?.focus();
  },
  acao(a) { if (a === 'sess-sair') return this.encerrar('saiu'); if (a === 'sess-cancelar') { this._pendente = null; this.prov.sair(); return this.render({}); } },
};
// formulários da tela de entrada (submit com Enter ou botão)
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
  const v = n => f.querySelector(`[name="${n}"]`)?.value || '';
  const falha = (r) => err => Sessao.render({ ...r, erro: err.message || String(err) });
  if (f.dataset.form === 'login') Sessao.entrar(v('cpf'), v('senha')).catch(falha({ cpf: v('cpf') }));
  if (f.dataset.form === 'troca') Sessao.trocarSenha(v('nova'), v('conf')).catch(falha({ troca: true }));
  if (f.dataset.form === 'setup') Sessao.configurar(v('nome'), v('cpf'), v('senha'), v('conf')).catch(falha({ setup: true }));
});
document.addEventListener('input', e => { if (e.target.matches?.('input[data-cpf]')) { const d = CPF.limpar(e.target.value).slice(0, 11); const fmt = d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2'); if (fmt !== e.target.value) e.target.value = fmt; } });
document.addEventListener('click', e => { const b = e.target.closest('[data-ver-senha]'); if (!b) return; const i = b.parentElement.querySelector('input'); const ver = i.type === 'password'; i.type = ver ? 'text' : 'password'; b.setAttribute('aria-label', ver ? 'Ocultar senha' : 'Mostrar senha'); b.innerHTML = ver ? ICON.olhoFechado : ICON.olho; });

/* ============================ Gestão de Acessos (só Master) ============================ */
const Acessos = {
  COL: 'usuarios',
  ui: { busca: '', situacao: '' },
  pronto() { return [this.COL, 'funcionarios'].every(c => Repo.prontas.has(c)); },
  todos() { return Repo.todos(this.COL); },
  funcionario(id) { return id ? Repo.get('funcionarios', id) : null; },
  nomeDe(u) { const f = this.funcionario(u.funcionarioId); return f?.nome || u.nome || '—'; },
  masters() { return this.todos().filter(u => u.perfil === 'MASTER' && u.ativo !== false); },
  situacao(u) {
    const f = this.funcionario(u.funcionarioId), s = Sessao.situacao(u, f);
    if (s === 'desativado') return { k: s, cls: 'neutral', txt: 'Desativado' };
    if (s === 'desligado') return { k: s, cls: 'bad', txt: 'Bloqueado: desligado no RH' };
    if (s === 'sem_funcionario') return { k: 'desligado', cls: 'bad', txt: 'Funcionário excluído' };
    if (u.trocarSenha) return { k: 'pendente', cls: 'warn', txt: 'Aguardando 1º acesso' };
    return { k: 'ativo', cls: 'ok', txt: 'Ativo' };
  },
  nivelTxt: { '': '—', ler: 'Ler', modificar: 'Modificar', excluir: 'Excluir' },
  resumoMatriz(u) {
    if (u.perfil === 'MASTER') return '<span class="pill navy">Acesso total</span>';
    const p = u.permissoes || {};
    return `<div class="acc-chips">${MATRIZ_MODULOS.map(m => `<span class="acc-chip n-${p[m.id] || 'nenhum'}" title="${esc(m.rotulo)}: ${this.nivelTxt[p[m.id] || '']}">${esc(m.curto)} <b>${this.nivelTxt[p[m.id] || '']}</b></span>`).join('')}</div>`;
  },
  /** Funcionários ativos (não desligados) que ainda não têm usuário. */
  semAcesso() {
    const ja = new Set(this.todos().map(u => u.funcionarioId).filter(Boolean)), cpfs = new Set(this.todos().filter(u => !u.funcionarioId).map(u => CPF.limpar(u.cpf)));
    return Repo.todos('funcionarios').filter(f => !Sessao.desligado(f) && !ja.has(f.id) && !cpfs.has(CPF.limpar(f.cpf))).sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
  },

  render() {
    if (!Auth.can('acessos.gerir')) return '<div class="panel"><div class="empty">A Gestão de Acessos é restrita ao perfil Master.</div></div>';
    const head = `<div class="page-head"><div><h1>Gestão de Acessos</h1><p>Ative os funcionários do Módulo 1 (login = CPF; senha inicial = CPF, com troca obrigatória no primeiro acesso) e defina a matriz Ler / Modificar / Excluir por módulo. Desligado no RH não entra mais.</p></div></div>`;
    if (!this.pronto()) return head + '<div class="panel"><p class="muted" style="margin:0">Carregando…</p></div>';
    const lista = this.todos(), sit = lista.map(u => this.situacao(u).k), sem = this.semAcesso();
    const kpis = `<div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Usuários ativos</div><div class="v">${sit.filter(s => s === 'ativo').length}</div><div class="d">${this.masters().length} Master</div></div>
      <div class="kpi zona-kpi ${sit.includes('pendente') ? 'warn' : 'ok'}"><div class="k">Aguardando 1º acesso</div><div class="v">${sit.filter(s => s === 'pendente').length}</div><div class="d">senha ainda é o CPF</div></div>
      <div class="kpi zona-kpi ${sit.includes('desligado') ? 'bad' : 'ok'}"><div class="k">Bloqueados pelo RH</div><div class="v">${sit.filter(s => s === 'desligado').length}</div><div class="d">desligado no Módulo 1</div></div>
      <div class="kpi"><div class="k">Desativados</div><div class="v">${sit.filter(s => s === 'desativado').length}</div><div class="d">pelo Master</div></div></div>`;
    const semCpf = sem.filter(f => !CPF.valido(f.cpf)), comCpf = sem.filter(f => CPF.valido(f.cpf));
    const ativar = `<div class="panel" style="margin-bottom:16px"><h2>Funcionários sem acesso</h2><p class="sub">Funcionários ativos do Módulo 1. Ao ativar, o usuário nasce como Operacional com a matriz padrão; ajuste em “Permissões”.</p>
      ${comCpf.length ? `<div class="tbl-wrap"><table><thead><tr><th>Funcionário</th><th>CPF</th><th>Situação no RH</th><th></th></tr></thead><tbody>${comCpf.map(f => `<tr><td><div class="cell-main">${esc(f.nome)}</div><div class="cell-sub">${esc(Pessoal.cargoNome?.(f) || '')}</div></td><td class="mono">${CPF.mascarar(f.cpf)}</td><td>${esc(f.status || 'Ativo')}</td>
        <td class="acts"><button class="btn sm" data-a="acc-ativar" data-f="${f.id}">Ativar acesso</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="padding:16px">Todos os funcionários ativos com CPF já têm acesso.</div>'}
      ${semCpf.length ? `<p class="hint" style="margin:10px 0 0">${semCpf.length} funcionário(s) sem CPF válido no Módulo 1 (${semCpf.slice(0, 4).map(f => esc(f.nome)).join(', ')}${semCpf.length > 4 ? '…' : ''}): cadastre o CPF para poder ativar.</p>` : ''}</div>`;
    const q = RH.chave(this.ui.busca), filtrados = lista.filter(u => (!this.ui.situacao || this.situacao(u).k === this.ui.situacao) && (!q || RH.chave(this.nomeDe(u)).includes(q))).sort((a, b) => this.nomeDe(a).localeCompare(this.nomeDe(b)));
    const tabela = `<div class="panel"><h2>Usuários</h2><div class="toolbar"><div class="field grow"><label class="lbl" for="accBusca">Buscar</label><input id="accBusca" type="search" value="${esc(this.ui.busca)}" data-a="acc-busca" placeholder="Nome"></div>
        <div class="field"><label class="lbl" for="accSit">Situação</label><select id="accSit" data-a="acc-filtro"><option value="">Todas</option>${[['ativo', 'Ativos'], ['pendente', 'Aguardando 1º acesso'], ['desligado', 'Bloqueados pelo RH'], ['desativado', 'Desativados']].map(([v, l]) => `<option value="${v}" ${this.ui.situacao === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="tbl-wrap"><table id="accTab"><thead><tr><th>Usuário</th><th>Login (CPF)</th><th>Perfil</th><th>Permissões</th><th>Situação</th><th>Último acesso</th><th></th></tr></thead><tbody>${filtrados.map(u => {
        const f = this.funcionario(u.funcionarioId), s = this.situacao(u), eu = u.id === Auth.id;
        return `<tr class="${['desligado', 'desativado'].includes(s.k) ? 'muted' : ''}"><td><div class="cell-main">${esc(this.nomeDe(u))}${eu ? ' <span class="hint">(você)</span>' : ''}</div><div class="cell-sub">${f ? esc([Pessoal.cargoNome?.(f), f.status || 'Ativo'].filter(Boolean).join(' · ')) : 'Master da configuração inicial'}</div></td>
          <td class="mono">${CPF.mascarar(Sessao.cpfDe(u, f))}</td>
          <td><span class="pill ${u.perfil === 'MASTER' ? 'navy' : 'neutral'}">${u.perfil === 'MASTER' ? 'Master' : 'Operacional'}</span></td><td>${this.resumoMatriz(u)}</td>
          <td><span class="pill ${s.cls}">${esc(s.txt)}</span></td><td class="mono">${u.ultimoAcesso ? Fmt.dataHora(u.ultimoAcesso) : '<span class="hint">nunca</span>'}</td>
          <td class="acts"><button class="btn sec sm" data-a="acc-editar" data-id="${u.id}">Permissões</button><button class="btn ghost sm" data-a="acc-reset" data-id="${u.id}">Resetar senha</button>
            ${eu ? '' : `<button class="btn ${u.ativo === false ? 'sec' : 'ghost'} sm" data-a="acc-ativo" data-id="${u.id}">${u.ativo === false ? 'Reativar' : 'Desativar'}</button><button class="iconbtn" data-a="acc-remover" data-id="${u.id}" aria-label="Remover usuário">${ICON.lixo}</button>`}</td></tr>`;
      }).join('') || '<tr><td colspan="7"><div class="empty">Nenhum usuário com esse filtro.</div></td></tr>'}</tbody></table></div></div>`;
    return head + kpis + ativar + tabela;
  },
  afterRender() { },

  /* ---------------- matriz Ler / Modificar / Excluir ---------------- */
  matrizHTML(perm = {}, master = false) {
    const cel = (m, n) => { const nv = NIVEIS_ACESSO.indexOf(perm[m.id] || ''), i = NIVEIS_ACESSO.indexOf(n);
      return `<td class="acc-cel"><input type="checkbox" data-mod="${m.id}" data-niv="${n}" aria-label="${esc(m.rotulo)}: ${this.nivelTxt[n]}" ${master || nv >= i ? 'checked' : ''} ${master || nv > i ? 'disabled' : ''}></td>`; };
    return `<div class="tbl-wrap"><table class="nolabel acc-matriz"><thead><tr><th>Módulo</th><th>Ler</th><th>Modificar</th><th>Excluir</th></tr></thead><tbody>
      ${MATRIZ_MODULOS.map(m => `<tr><td><b>${esc(m.rotulo)}</b><div class="cell-sub">${esc(m.num)}</div></td>${['ler', 'modificar', 'excluir'].map(n => cel(m, n)).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="hint" style="margin-top:6px">Modificar inclui Ler; Excluir inclui Modificar e Ler. ${master ? 'Master tem acesso total, inclusive à Gestão de Acessos, Auditoria e Backup.' : 'Salários, parâmetros de RH, Auditoria, Backup e Gestão de Acessos ficam só com o Master.'}</p>`;
  },
  lerMatriz(m) { const out = {}; MATRIZ_MODULOS.forEach(mod => { out[mod.id] = ['excluir', 'modificar', 'ler'].find(v => $(`[data-mod="${mod.id}"][data-niv="${v}"]`, m)?.checked) || ''; }); return out; },
  /** Cascata: marcar um nível marca e trava os de baixo; desmarcar deixa o nível logo abaixo. */
  sincronizarMatriz(m, alvo) {
    const master = $('[name="perfil"]', m)?.value === 'MASTER', perm = master ? {} : this.lerMatriz(m);
    if (alvo && !alvo.checked && !master) perm[alvo.dataset.mod] = NIVEIS_ACESSO[NIVEIS_ACESSO.indexOf(alvo.dataset.niv) - 1];
    $('#accMatriz', m).innerHTML = this.matrizHTML(perm, master);
  },
  abrirPermissoes(id) {
    const u = Repo.get(this.COL, id), eu = id === Auth.id;
    UI.modal({
      titulo: 'Permissões · ' + this.nomeDe(u), largo: true,
      corpo: `<div class="form-grid">${campo('Perfil', 'perfil', u.perfil, { opcoes: [['OPERACIONAL', 'Operacional (matriz por módulo)'], ['MASTER', 'Master (acesso total)']], attrs: eu ? 'disabled' : '' })}
        <div class="field full"><span class="lbl">Permissões por módulo</span><div id="accMatriz">${this.matrizHTML(u.permissoes || {}, u.perfil === 'MASTER')}</div></div></div>${eu ? '<p class="hint">Você não pode mudar o seu próprio perfil.</p>' : ''}`,
      aoAbrir: m => m.addEventListener('change', e => { if (e.target.matches('[data-mod]')) this.sincronizarMatriz(m, e.target); if (e.target.name === 'perfil') this.sincronizarMatriz(m); }),
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar permissões', acao: async m => {
        const perfil = eu ? u.perfil : $('[name="perfil"]', m).value;
        if (u.perfil === 'MASTER' && perfil !== 'MASTER' && this.masters().length <= 1) { UI.toast('Este é o único Master ativo: defina outro Master antes.'); return false; }
        const { id: _, ...d } = u;
        await Repo.salvar(this.COL, id, { ...d, perfil, permissoes: perfil === 'MASTER' ? {} : this.lerMatriz(m) }, { modulo: 'acessos', rotulo: `Acesso · ${this.nomeDe(u)}`, detalhe: 'Permissões alteradas' });
        UI.toast('Permissões salvas: valem na hora para a pessoa.');
      } }],
    });
  },
  async ativar(fid) {
    const f = this.funcionario(fid); if (!f) return;
    if (!CPF.valido(f.cpf)) return UI.toast('Cadastre um CPF válido para este funcionário no Módulo 1.');
    if (Sessao.desligado(f)) return UI.toast('Funcionário desligado no Módulo 1.');
    if (this.todos().some(u => u.funcionarioId === fid)) return UI.toast('Este funcionário já tem acesso.');
    if (this.todos().some(u => Sessao.cpfDe(u, this.funcionario(u.funcionarioId)) === CPF.limpar(f.cpf))) return UI.toast('Já existe um usuário com este CPF.');
    UI.toast('Ativando acesso…');
    const id = await Sessao.prov.criarAcesso(f, { perfil: 'OPERACIONAL', funcionarioId: fid, permissoes: { ...MATRIZ_PADRAO }, ativo: true, trocarSenha: true });
    UI.toast(`Acesso de ${f.nome} ativado. Login e senha inicial: o CPF.`);
    this.abrirPermissoes(id);
  },

  /* ---------------- eventos (prefixo acc-) ---------------- */
  async acao(a, el) {
    const id = el.dataset.id, u = id ? Repo.get(this.COL, id) : null;
    switch (a) {
      case 'acc-ativar': return this.ativar(el.dataset.f);
      case 'acc-editar': return this.abrirPermissoes(id);
      case 'acc-reset': {
        const cpf = Sessao.cpfDe(u, this.funcionario(u.funcionarioId)); if (!CPF.valido(cpf)) return UI.toast('O funcionário não tem CPF válido no Módulo 1.');
        if (!(await UI.confirmar('Resetar senha', `A senha de <b>${esc(this.nomeDe(u))}</b> volta a ser o CPF e a troca será obrigatória no próximo login. Uma sessão aberta dessa pessoa é encerrada.`, 'Resetar senha', true))) return;
        await Sessao.prov.resetarSenha(u, cpf, `Acesso · ${this.nomeDe(u)}`);
        return UI.toast('Senha resetada para o CPF.');
      }
      case 'acc-ativo': {
        const novo = u.ativo === false;
        if (!novo && u.perfil === 'MASTER' && this.masters().length <= 1) return UI.toast('Este é o único Master ativo.');
        if (!novo && !(await UI.confirmar('Desativar acesso', `Desativar o acesso de <b>${esc(this.nomeDe(u))}</b>? A pessoa sai do painel na hora.`, 'Desativar', true))) return;
        const { id: _, ...d } = u; return Repo.salvar(this.COL, id, { ...d, ativo: novo }, { modulo: 'acessos', rotulo: `Acesso · ${this.nomeDe(u)}`, detalhe: novo ? 'Reativado' : 'Desativado' });
      }
      case 'acc-remover': {
        if (u.perfil === 'MASTER' && this.masters().length <= 1) return UI.toast('Este é o único Master ativo.');
        if (!(await UI.confirmar('Remover usuário', `Remover o acesso de <b>${esc(this.nomeDe(u))}</b>? O funcionário continua no Módulo 1 e pode ser ativado de novo.`, 'Remover', true))) return;
        return Sessao.prov.removerAcesso(u, `Acesso · ${this.nomeDe(u)}`);
      }
    }
  },
  mudanca(a, el) { if (a === 'acc-filtro') { this.ui.situacao = el.value; App.render(); } },
  entrada(a, el) { if (a === 'acc-busca') { this.ui.busca = el.value; App.render(); } },
};
