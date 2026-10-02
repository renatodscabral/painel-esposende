/* =====================================================================
   MÓDULO 1 — GESTÃO DE PESSOAL (Equipe + PDI)
   Coleções:
     funcionarios/<id>  dados cadastrais e de jornada (sem salário)
     salarios/<id>      { valor, desde, historico[] }  ← leitura só GESTOR (regra do banco)
     pdi/<id>           { metas{}, avaliacoes[], plano[] }
   ===================================================================== */

/* ---------- Matriz de competências do PDI ---------- */
const COMPETENCIAS = [
  { id: 'visaoFinanceira', nome: 'Visão Financeira', curto: 'Fin',
    descricao: 'Entende como o próprio trabalho afeta venda, margem, despesa e caixa. Acompanha metas e indicadores da loja ou da área e usa números para justificar escolhas.',
    forte: 'Lê resultados com facilidade e relaciona decisões do dia a dia ao impacto em margem e caixa.',
    acoes: ['Acompanhar semanalmente o resultado da loja/área (venda, ticket médio, despesas) com o gestor.', 'Explicar em uma reunião de equipe como uma despesa ou desconto afeta a margem.', 'Fazer a trilha interna de noções de DRE e fluxo de caixa.'] },
  { id: 'analiseDados', nome: 'Análise de Dados', curto: 'Dados',
    descricao: 'Coleta, organiza e interpreta dados (planilhas, relatórios do sistema) para encontrar causas e tendências, sem depender de "achismo".',
    forte: 'Transforma relatórios em conclusões claras e aponta tendências antes que virem problema.',
    acoes: ['Montar um acompanhamento mensal em planilha com 3 indicadores da própria rotina.', 'Praticar tabela dinâmica e gráficos no Excel com um caso real da loja.', 'Apresentar uma análise curta (1 página) com conclusão e recomendação.'] },
  { id: 'comunicacao', nome: 'Comunicação', curto: 'Com',
    descricao: 'Transmite informações de forma clara, objetiva e respeitosa, por escrito e falando. Escuta ativamente e confirma entendimento.',
    forte: 'É claro e objetivo; as pessoas entendem o recado de primeira e se sentem ouvidas.',
    acoes: ['Conduzir a reunião rápida (5 minutos) de abertura da loja/equipe uma vez por semana.', 'Revisar e-mails e mensagens importantes com a regra: contexto, pedido e prazo.', 'Pedir feedback ao gestor após uma apresentação ou conversa difícil.'] },
  { id: 'lideranca', nome: 'Liderança', curto: 'Lid',
    descricao: 'Orienta, desenvolve e engaja pessoas em direção aos objetivos. Dá exemplo, reconhece bons resultados e dá feedback construtivo.',
    forte: 'Mobiliza a equipe, dá exemplo e desenvolve as pessoas ao redor.',
    acoes: ['Assumir a integração de um novo colaborador (acompanhamento das primeiras semanas).', 'Dar um feedback estruturado (situação, comportamento, impacto) por mês.', 'Liderar uma ação ou campanha da loja do início ao fim.'] },
  { id: 'tomadaDecisao', nome: 'Tomada de Decisão', curto: 'Dec',
    descricao: 'Avalia alternativas, riscos e impactos e decide no tempo certo, dentro da própria alçada. Assume a responsabilidade pela escolha.',
    forte: 'Decide com agilidade e bom critério, e sabe quando escalar para o gestor.',
    acoes: ['Registrar 2 decisões do mês com alternativas consideradas e resultado obtido.', 'Combinar com o gestor quais decisões estão na sua alçada.', 'Resolver uma situação de cliente ou operação sem escalar, e depois revisar com o gestor.'] },
  { id: 'organizacao', nome: 'Organização', curto: 'Org',
    descricao: 'Planeja a rotina, prioriza tarefas, cumpre prazos e mantém processos, documentos e espaço de trabalho em ordem.',
    forte: 'Entrega no prazo, com rotina planejada e processos em ordem.',
    acoes: ['Usar uma lista semanal de prioridades revisada toda segunda-feira.', 'Padronizar um processo da rotina (checklist de abertura/fechamento, conferência, arquivo).', 'Zerar pendências com mais de 15 dias.'] },
  { id: 'influencia', nome: 'Influência', curto: 'Inf',
    descricao: 'Conquista apoio e adesão a ideias usando argumentos, dados e relacionamento, dentro e fora da própria equipe.',
    forte: 'Consegue adesão às suas propostas e constrói boas parcerias entre áreas.',
    acoes: ['Apresentar uma proposta de melhoria com dados para o gestor ou supervisor.', 'Criar parceria com outra área (DP, financeiro, logística) para resolver um problema recorrente.', 'Preparar os argumentos antes de negociações e conversas importantes.'] },
];
const NIVEIS = { 1: 'Inicial', 2: 'Em desenvolvimento', 3: 'Proficiente', 4: 'Avançado', 5: 'Referência' };
const META_PADRAO = 4;
const SETORES = ['Escritório / Administrativo', 'Centro de Distribuição', 'Financeiro', 'Departamento Pessoal', 'Marketing', 'Compras', 'TI', 'Diretoria'];
const ESCALAS = ['6x1', '5x2', '12x36', '4x2', 'Personalizada'];
const DIAS_SEMANA = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const STATUS_FUNC = ['Ativo', 'Férias', 'Afastado', 'Desligado'];

const Pessoal = {
  ui: { aba: 'equipe', busca: '', lotacao: '', status: 'Ativo', verSalarios: false, revelados: new Set(), pdiSel: null, rh: { tab: 'cargos', busca: '', status: 'ativo' } },

  colecoes() { const c = ['funcionarios', 'pdi', 'lojas', 'config', 'rh_cargos', 'rh_centros']; if (Auth.can('pessoal.salario.ver')) c.push('salarios'); return c; },

  /* ---------------- helpers de dados ---------------- */
  /** Loja de lotação e/ou centro de custo (setor = campo legado, anterior às tabelas de domínio). */
  lotacaoNome(f) {
    const partes = [];
    if (f.lotacao && f.lotacao.startsWith('loja-')) { const l = Repo.get('lojas', f.lotacao); partes.push(l ? `${l.codigo} · ${l.nome}` : f.lotacao); }
    const cc = RH.get('centros', f.centroCustoId);
    if (cc) partes.push('CC ' + (cc.codigo || cc.nome)); else if (f.centroCusto) partes.push(f.centroCusto); else if (f.setor) partes.push(f.setor);
    return partes.join(' · ') || '—';
  },
  cargoNome(f) { const c = RH.get('cargos', f.cargoId); return c ? c.nome : (f.cargo || ''); },
  /** Opções do filtro de lotação: lojas + centros de custo ativos. */
  opcoesLotacao() {
    const lojas = Repo.todos('lojas').sort((a, b) => a.codigo.localeCompare(b.codigo)).map(l => ['loja-' + l.codigo, `Loja ${l.codigo} · ${l.nome}`]);
    return [['', 'Selecione…'], ...lojas, ...RH.ativos('centros').map(c => ['cc:' + c.id, 'CC ' + RH.rotulo(c)])];
  },
  /** <option>s de uma tabela de domínio: só ativos + o valor atual (mesmo inativo, para não perdê-lo). */
  opcoesDominio(tipo, atualId, textoLegado) {
    const ativos = RH.ativos(tipo), atual = RH.get(tipo, atualId);
    const lista = atual && atual.status === 'inativo' ? [...ativos, atual] : ativos;
    const vazio = ativos.length ? 'Selecione…' : `Nenhum ${RH_TABELAS[tipo].singular} ativo cadastrado`;
    return `<option value="">${vazio}</option>` + lista.map(x => `<option value="${x.id}" ${x.id === atualId ? 'selected' : ''}>${esc(RH.rotulo(x))}${x.status === 'inativo' ? ' (inativo)' : ''}</option>`).join('')
      + (!atual && textoLegado ? `<option value="txt:${esc(textoLegado)}" selected>${esc(textoLegado)} (não cadastrado)</option>` : '');
  },
  /** Situação de férias pela CLT (período aquisitivo de 12 meses + concessivo de 12 meses). */
  ferias(f) {
    const a = Datas.de(f.admissao); if (!a) return { txt: 'Sem admissão', cls: 'neutral' };
    const hoje = Datas.hoje(); const completos = Math.floor(Datas.mesesEntre(a, hoje) / 12);
    const gozados = Number(f.ferias?.periodosGozados || 0); const pend = Math.max(0, completos - gozados);
    const prog = f.ferias?.programadaInicio && Datas.de(f.ferias.programadaInicio) >= hoje ? ` · programadas ${Fmt.data(f.ferias.programadaInicio)}` : '';
    if (pend === 0) { const prox = Datas.addAnos(a, completos + 1); return { txt: `Adquire em ${Fmt.data(Datas.iso(prox))}`, cls: 'neutral', prog }; }
    const limite = new Date(Datas.addAnos(a, gozados + 2).getTime() - 864e5); const d = Datas.dias(hoje, limite);
    if (d < 0) return { txt: `Vencidas há ${-d} dias`, cls: 'bad', det: 'Pagamento em dobro (CLT art. 137)', prog, limite };
    if (d <= 60) return { txt: `Vencem em ${d} dias`, cls: 'warn', det: 'Limite ' + Fmt.data(Datas.iso(limite)), prog, limite };
    return { txt: `${pend} período${pend > 1 ? 's' : ''} a gozar`, cls: 'ok', det: 'Limite ' + Fmt.data(Datas.iso(limite)), prog, limite };
  },
  pdiDe(id) { return Repo.get('pdi', id) || { metas: {}, avaliacoes: [], plano: [] }; },
  ultimas(pdi) { const av = [...(pdi.avaliacoes || [])].sort((a, b) => (a.data || '').localeCompare(b.data || '')); return { atual: av.at(-1), anterior: av.at(-2), todas: av }; },
  media(notas) { const v = COMPETENCIAS.map(c => notas?.[c.id]).filter(n => n > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; },
  hcell(n, extra = '') { const k = n > 0 ? Math.round(n) : 0; return `<span class="hcell h${k}" title="${n > 0 ? NIVEIS[k] : 'Sem avaliação'}" ${extra}>${n > 0 ? n : '–'}</span>`; },

  /* ---------------- tela principal ---------------- */
  render() {
    const u = this.ui;
    if (u.aba === 'pdi' && u.pdiSel) return this.renderPdiDetalhe(u.pdiSel);
    return `
      <div class="page-head"><div><h1>Gestão de Pessoal</h1><p>Equipe, jornada, férias e Plano de Desenvolvimento Interno (PDI).</p></div>
        <div class="row">${Auth.can('pessoal.salario.editar') ? `<button class="btn sec" data-a="folha-params">Parâmetros da folha</button>` : ''}${Auth.can('pessoal.editar') ? `<button class="btn" data-a="func-novo">+ Novo colaborador</button>` : ''}</div></div>
      <div class="tabs" role="tablist">
        <button class="${u.aba === 'equipe' ? 'on' : ''}" data-a="pes-aba" data-v="equipe">Equipe</button>
        <button class="${u.aba === 'pdi' ? 'on' : ''}" data-a="pes-aba" data-v="pdi">PDI · Matriz de competências</button>
        ${Auth.can('pessoal.parametros') ? `<button class="${u.aba === 'rh' ? 'on' : ''}" data-a="pes-aba" data-v="rh">Parametrizações de RH</button>` : ''}
      </div>
      ${u.aba === 'equipe' ? this.renderEquipe() : u.aba === 'rh' && Auth.can('pessoal.parametros') ? this.renderParametros() : this.renderPdiLista()}`;
  },

  filtrados() {
    const u = this.ui, q = u.busca.toLowerCase();
    return Repo.todos('funcionarios')
      .filter(f => (!u.status || (f.status || 'Ativo') === u.status) && (!u.lotacao || f.lotacao === u.lotacao || ('cc:' + f.centroCustoId) === u.lotacao)
        && (!q || [f.nome, f.matricula, this.cargoNome(f), this.lotacaoNome(f)].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  },
  filtrosHTML() {
    const u = this.ui;
    return `<div class="toolbar">
      <div class="field grow"><label class="lbl" for="pesBusca">Buscar</label><input id="pesBusca" type="search" placeholder="Nome, matrícula, cargo…" value="${esc(u.busca)}" data-a="pes-busca"></div>
      <div class="field"><label class="lbl" for="pesLot">Lotação</label><select id="pesLot" data-a="pes-filtro" data-k="lotacao">${this.opcoesLotacao().map(([v, l]) => `<option value="${esc(v)}" ${v === u.lotacao ? 'selected' : ''}>${esc(v ? l : 'Todas')}</option>`).join('')}</select></div>
      <div class="field"><label class="lbl" for="pesSt">Situação</label><select id="pesSt" data-a="pes-filtro" data-k="status"><option value="">Todas</option>${STATUS_FUNC.map(s => `<option ${s === u.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>`;
  },

  /** KPI de custo total da folha (GESTOR). Valor mascarado até exibir os salários. */
  kpiCustoFolha(todos) {
    const calcs = todos.map(f => { const s = Repo.get('salarios', f.id); return s?.valor ? Folha.calcular(s.valor, { dependentes: f.dependentesIR }) : null; }).filter(Boolean);
    const custo = calcs.reduce((a, c) => a + c.custoTotal, 0), base = calcs.reduce((a, c) => a + c.base, 0);
    const ver = this.ui.verSalarios;
    return `<div class="kpi"><div class="k">Custo real da folha (mês)</div><div class="v mono">${ver ? Fmt.brl0(custo) : '<span class="mask" style="color:var(--ink-faint)">R$ ••••••</span>'}</div>
      <div class="d">${ver && base ? `${Fmt.num(custo / base, 2)}× os salários · ${calcs.length} com salário` : `${calcs.length} colaboradores com salário`}${Auth.can('pessoal.salario.editar') ? ` · <button class="btn ghost sm" style="padding:0 2px" data-a="folha-params">parâmetros</button>` : ''}</div></div>`;
  },

  renderEquipe() {
    if (!Repo.prontas.has('funcionarios')) return `<div class="panel"><p class="muted">Carregando equipe…</p></div>`;
    const lista = this.filtrados(), todos = Repo.todos('funcionarios').filter(f => (f.status || 'Ativo') !== 'Desligado');
    const podeSal = Auth.can('pessoal.salario.ver');
    const saldoBH = todos.reduce((a, f) => a + (Number(f.bancoHoras) || 0), 0);
    const feriasAlerta = todos.filter(f => ['warn', 'bad'].includes(this.ferias(f).cls)).length;
    const exemplos = todos.filter(f => f.exemplo).length;
    const linhas = lista.map(f => {
      const fe = this.ferias(f), bh = Number(f.bancoHoras) || 0, sal = Repo.get('salarios', f.id);
      const aberto = this.ui.verSalarios || this.ui.revelados.has(f.id);
      // Salário: base + líquido estimado + custo real (Folha.calcular), ocultos até clicar no olho
      const calc = sal?.valor ? Folha.calcular(sal.valor, { dependentes: f.dependentesIR }) : null;
      const salCell = !podeSal ? '' : `<td class="num"><div class="secret" style="justify-content:flex-end">
          ${aberto ? (calc ? `<div class="sal-stack"><span title="Salário base"><em>Base</em> ${Fmt.brl(calc.base)}</span><span title="Folha líquida estimada"><em>Líquido</em> ${Fmt.brl(calc.liquido)}</span><span class="custo" title="Custo real para a empresa"><em>Custo</em> ${Fmt.brl(calc.custoTotal)}</span></div>` : '<span class="hint">sem salário</span>') : '<span class="mask">R$ ••••••</span>'}
          <button class="iconbtn" data-a="sal-toggle" data-id="${f.id}" aria-label="${aberto ? 'Ocultar' : 'Exibir'} salário">${aberto ? ICON.olhoFechado : ICON.olho}</button></div></td>`;
      return `<tr class="click" data-a="func-editar" data-id="${f.id}">
        <td><div class="cell-main">${esc(f.nome)} ${f.exemplo ? '<span class="pill neutral">exemplo</span>' : ''}</div><div class="cell-sub mono">Mat. ${esc(f.matricula || '—')}</div></td>
        <td><div>${esc(this.cargoNome(f) || '—')}</div><div class="cell-sub">${esc(this.lotacaoNome(f))}</div></td>
        <td><div class="mono">${Fmt.data(f.admissao)}</div><div class="cell-sub">${Datas.tempoDeCasa(f.admissao)}</div></td>
        <td><div>${esc(f.escala || '—')}</div><div class="cell-sub">Folga: ${esc((f.folgas || []).join(', ') || f.folgaObs || '—')}</div></td>
        <td class="num"><span class="mono" style="color:var(${bh < 0 ? '--bad' : bh > 0 ? '--ok' : '--ink-soft'})">${Fmt.horas(bh)}</span></td>
        <td><span class="pill ${fe.cls}">${esc(fe.txt)}</span>${fe.prog ? `<div class="cell-sub">${esc(fe.prog.slice(3))}</div>` : ''}</td>
        ${salCell}
        <td><span class="pill ${({ Ativo: 'ok', Férias: 'info', Afastado: 'warn', Desligado: 'neutral' })[f.status || 'Ativo']}">${esc(f.status || 'Ativo')}</span></td>
      </tr>`;
    }).join('');
    return `
      <div class="grid g4" style="margin-bottom:16px;">
        <div class="kpi"><div class="k">Colaboradores ativos</div><div class="v">${todos.length}</div><div class="d">${exemplos ? exemplos + ' de exemplo' : 'em ' + new Set(todos.map(f => f.lotacao || f.setor)).size + ' lotações'}</div></div>
        <div class="kpi"><div class="k">Banco de horas (saldo)</div><div class="v mono" style="color:var(${saldoBH < 0 ? '--bad' : '--ok'})">${Fmt.horas(saldoBH)}</div><div class="d">soma da equipe</div></div>
        <div class="kpi"><div class="k">Férias em alerta</div><div class="v">${feriasAlerta}</div><div class="d">vencidas ou vencendo em 60 dias</div></div>
        ${podeSal ? this.kpiCustoFolha(todos) : `<div class="kpi"><div class="k">PDI avaliados</div><div class="v">${todos.filter(f => this.pdiDe(f.id).avaliacoes?.length).length}</div><div class="d">de ${todos.length} colaboradores</div></div>`}
      </div>
      <div class="panel">
        ${this.filtrosHTML()}
        ${podeSal ? `<div class="row" style="justify-content:flex-end;margin:-4px 0 10px"><button class="btn sec sm" data-a="sal-todos">${this.ui.verSalarios ? ICON.olhoFechado + ' Ocultar salários e custos' : ICON.olho + ' Exibir salários e custos'}</button></div>` : ''}
        ${lista.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>Colaborador</th><th>Cargo · lotação</th><th>Admissão</th><th>Escala · folgas</th><th class="num">Banco de horas</th><th>Férias</th>
          ${podeSal ? `<th class="num"><span class="row" style="justify-content:flex-end;gap:4px">Salário · líquido · custo <button class="iconbtn" data-a="sal-todos" aria-label="${this.ui.verSalarios ? 'Ocultar' : 'Exibir'} todos os salários">${this.ui.verSalarios ? ICON.olhoFechado : ICON.olho}</button></span></th>` : ''}
          <th>Situação</th></tr></thead><tbody>${linhas}</tbody></table></div>`
        : `<div class="empty">${Repo.todos('funcionarios').length ? 'Nenhum colaborador com esses filtros.' : 'Nenhum colaborador cadastrado ainda. Use “+ Novo colaborador”.'}</div>`}
        ${!podeSal ? '<p class="hint" style="margin-top:10px">Salários visíveis apenas para o perfil GESTOR.</p>' : ''}
      </div>`;
  },

  /* ---------------- formulário de colaborador ---------------- */
  abrirForm(id) {
    const f = id ? Repo.get('funcionarios', id) : { status: 'Ativo', escala: '6x1', folgas: [], ferias: { periodosGozados: 0 }, bancoHoras: 0 };
    const sal = id ? Repo.get('salarios', id) : null;
    const podeEd = Auth.can('pessoal.editar'), podeSalEd = Auth.can('pessoal.salario.editar');
    const lotVal = f.lotacao || (f.setor ? 'setor:' + f.setor : '');
    const dis = podeEd ? '' : 'disabled';
    const corpo = `<form class="form-grid" onsubmit="return false">
      ${campo('Nome completo', 'nome', f.nome, { attrs: dis + ' required' })}
      ${campo('Matrícula', 'matricula', f.matricula, { attrs: dis })}
      ${campo('CPF', 'cpf', CPF.formatar(f.cpf), { attrs: dis + ' inputmode="numeric" placeholder="000.000.000-00" data-cpf', dica: 'É o login do painel (e a senha inicial) quando o Master ativa o acesso.' })}
      <div class="field"><label class="lbl" for="f_cargoId">Cargo</label><select id="f_cargoId" name="cargoId" ${dis}>${this.opcoesDominio('cargos', f.cargoId, f.cargo)}</select></div>
      <div class="field"><label class="lbl" for="f_centro">Centro de custo</label><select id="f_centro" name="centroCustoId" ${dis}>${this.opcoesDominio('centros', f.centroCustoId, f.centroCusto || f.setor)}</select></div>
      ${campo('Loja de lotação (opcional)', 'lotacaoSel', lotVal.startsWith('loja-') ? lotVal : '', { opcoes: [['', 'Sem loja (escritório / CD)'], ...Repo.todos('lojas').filter(l => l.ativa || 'loja-' + l.codigo === lotVal).sort((a, b) => a.codigo.localeCompare(b.codigo)).map(l => ['loja-' + l.codigo, `Loja ${l.codigo} · ${l.nome}`])], attrs: dis })}
      ${!RH.ativos('cargos').length || !RH.ativos('centros').length ? `<p class="hint full" style="margin:-4px 0 0">${Auth.can('pessoal.parametros') ? 'Cadastre cargos e centros de custo em <b>Parametrizações de RH</b>.' : 'Peça ao GESTOR para cadastrar cargos e centros de custo.'}</p>` : ''}
      ${campo('Data de admissão', 'admissao', f.admissao, { tipo: 'date', attrs: dis })}
      ${campo('Situação', 'status', f.status, { opcoes: STATUS_FUNC, attrs: dis })}
      ${campo('Escala', 'escala', f.escala, { opcoes: ESCALAS, attrs: dis })}
      <div class="field"><span class="lbl">Folgas fixas</span><div class="row" style="gap:10px;padding-top:6px">${DIAS_SEMANA.map(d => `<label class="check"><input type="checkbox" name="folgas" data-lista="1" value="${d}" ${(f.folgas || []).includes(d) ? 'checked' : ''} ${dis}>${d}</label>`).join('')}</div></div>
      ${campo('Observação de folgas', 'folgaObs', f.folgaObs, { attrs: dis, dica: 'Ex.: folga rotativa no domingo, 1 domingo por mês.' })}
      ${campo('Banco de horas (saldo em horas)', 'bancoHoras', f.bancoHoras, { tipo: 'number', attrs: dis, dica: 'Use negativo para débito. Ex.: 12.5 = 12h30; −3 = 3h devidas.' })}
      ${campo('Períodos de férias já gozados', 'ferias.periodosGozados', f.ferias?.periodosGozados ?? 0, { tipo: 'number', attrs: dis + ' min="0"', dica: 'Quantos períodos aquisitivos já foram gozados desde a admissão.' })}
      <div class="field"><span class="lbl">Férias programadas</span><div class="row" style="flex-wrap:nowrap"><input type="date" name="ferias.programadaInicio" value="${esc(f.ferias?.programadaInicio || '')}" aria-label="Início das férias" ${dis}><input type="date" name="ferias.programadaFim" value="${esc(f.ferias?.programadaFim || '')}" aria-label="Fim das férias" ${dis}></div></div>
      ${podeSalEd ? campo('Salário atual (R$)', '_salario', sal?.valor, { tipo: 'number', dica: 'Visível apenas para GESTOR. Alterações ficam no histórico e no log.' }) : ''}
      ${campo('Dependentes para IRRF', 'dependentesIR', f.dependentesIR ?? 0, { tipo: 'number', attrs: dis + ' min="0"' })}
      ${Auth.can('pessoal.salario.ver') ? `<div class="field full"><span class="lbl">Folha líquida e custo real</span><div id="folhaComp">${Folha.composicaoHTML(sal?.valor ? Folha.calcular(sal.valor, { dependentes: f.dependentesIR }) : null)}</div></div>` : ''}
      ${campo('E-mail', 'email', f.email, { tipo: 'email', attrs: dis })}
      ${campo('Telefone', 'telefone', f.telefone, { attrs: dis })}
    </form>
    ${sal?.historico?.length && Auth.can('pessoal.salario.ver') ? `<details class="log" style="margin-top:14px"><summary>Histórico salarial (${sal.historico.length})</summary><table style="margin-top:8px"><tbody>${sal.historico.slice().reverse().map(h => `<tr><td class="mono">${Fmt.data(h.desde)}</td><td class="num">${Fmt.brl(h.valor)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
    const acoes = [{ rotulo: 'Cancelar', classe: 'sec' }];
    if (id && Auth.can('pessoal.excluir')) acoes.unshift({ rotulo: 'Excluir', classe: 'danger', acao: async () => { if (!(await UI.confirmar('Excluir colaborador', `Excluir <b>${esc(f.nome)}</b>? O registro sai do painel, mas fica no log de auditoria.`, 'Excluir', true))) return false; await Repo.excluir('funcionarios', id, { modulo: 'pessoal', rotulo: f.nome }); if (Repo.get('salarios', id)) await Repo.excluir('salarios', id, { modulo: 'pessoal', rotulo: f.nome + ' (salário)' }); UI.toast('Colaborador excluído'); } });
    if (podeEd || podeSalEd) acoes.push({ rotulo: 'Salvar', acao: async m => this.salvarForm(m, id, f, sal) });
    if (id) acoes.splice(acoes.length - 1, 0, { rotulo: 'Ver PDI', classe: 'sec', acao: () => { this.ui.aba = 'pdi'; this.ui.pdiSel = id; App.render(); } });
    UI.modal({
      titulo: id ? 'Colaborador · ' + f.nome : 'Novo colaborador', corpo, acoes, largo: true,
      // recalcula a composição da folha enquanto o salário/dependentes são digitados
      aoAbrir: m => {
        // ao escolher a loja, sugere o centro de custo da loja (ex.: "2.05.014 – 014 - SHOPPING TACARUNA I")
        $('[name="lotacaoSel"]', m)?.addEventListener('change', e => {
          const cc = $('[name="centroCustoId"]', m); if (!cc || cc.value) return;
          const l = Repo.get('lojas', e.target.value); if (!l) return;
          const alvo = RH.ativos('centros').find(c => new RegExp('^0*' + Number(l.codigo) + '\\s*-').test(c.nome.trim()) || c.nome.startsWith(l.codigo + ' -'));
          if (alvo) { cc.value = alvo.id; UI.toast('Centro de custo sugerido: ' + RH.rotulo(alvo)); }
        });
        m.addEventListener('input', e => {
        if (!['_salario', 'dependentesIR'].includes(e.target.name)) return;
        const alvo = $('#folhaComp', m); if (!alvo) return;
        const v = Number($('[name="_salario"]', m)?.value || sal?.valor || 0);
        alvo.innerHTML = Folha.composicaoHTML(v ? Folha.calcular(v, { dependentes: Number($('[name="dependentesIR"]', m).value) || 0 }) : null);
        });
      },
    });
  },
  async salvarForm(m, id, antes, salAntes) {
    const d = UI.lerForm(m);
    if (!d.nome) { UI.toast('Informe o nome.'); return false; }
    d.cpf = CPF.limpar(d.cpf);
    if (d.cpf && !CPF.valido(d.cpf)) { UI.toast('CPF inválido: confira os dígitos.'); return false; }
    if (d.cpf && Repo.todos('funcionarios').some(x => x.id !== id && CPF.limpar(x.cpf) === d.cpf)) { UI.toast('Já existe outro colaborador com este CPF.'); return false; }
    const sel = d.lotacaoSel || ''; delete d.lotacaoSel;
    d.lotacao = sel.startsWith('loja-') ? sel : '';
    // cargo e centro de custo: id da tabela de domínio + nome copiado (compatibilidade com telas/relatórios antigos)
    if (!d.cargoId) { UI.toast('Selecione o cargo.'); return false; }
    if (d.cargoId.startsWith('txt:')) { d.cargo = d.cargoId.slice(4); d.cargoId = ''; } else d.cargo = RH.get('cargos', d.cargoId)?.nome || '';
    if (d.centroCustoId?.startsWith('txt:')) { d.centroCusto = d.centroCustoId.slice(4); d.centroCustoId = ''; } else d.centroCusto = RH.rotulo(RH.get('centros', d.centroCustoId));
    if (d.centroCustoId || d.centroCusto) d.setor = '';
    const salario = d._salario; delete d._salario;
    const novoId = id || 'func-' + uid();
    if (Auth.can('pessoal.editar')) {
      const dados = mergeProfundo(id ? antes : {}, d); dados.folgas = d.folgas || []; delete dados.exemplo; if (antes?.exemplo) dados.exemplo = true;
      await Repo.salvar('funcionarios', novoId, dados, { modulo: 'pessoal', rotulo: d.nome });
    }
    if (Auth.can('pessoal.salario.editar') && salario != null && salario !== salAntes?.valor) {
      const hist = [...(salAntes?.historico || []), { valor: salario, desde: Datas.hojeISO(), registradoPor: Auth.id }];
      await Repo.salvar('salarios', novoId, { valor: salario, desde: Datas.hojeISO(), historico: hist }, { modulo: 'pessoal', rotulo: d.nome + ' (salário)' });
    }
    UI.toast('Colaborador salvo');
  },

  /* ---------------- Parametrizações de RH (somente GESTOR) ---------------- */
  renderParametros() {
    const u = this.ui.rh, t = RH_TABELAS[u.tab];
    if (!Repo.prontas.has(t.col)) return '<div class="panel"><p class="muted">Carregando…</p></div>';
    const q = RH.chave(u.busca);
    const todos = RH.lista(u.tab, { inativos: true });
    const lista = todos.filter(x => (u.status === 'todos' || (x.status || 'ativo') === u.status) && (!q || RH.chave(x.codigo + ' ' + x.nome).includes(q)));
    const nAtivos = todos.filter(x => x.status !== 'inativo').length;
    return `<div class="panel">
      <div class="row between" style="margin-bottom:12px">
        <div class="seg">${Object.entries(RH_TABELAS).map(([k, tb]) => `<button class="${u.tab === k ? 'on' : ''}" data-a="pes-rh-tab" data-v="${k}">${tb.rotulo} (${RH.lista(k).length})</button>`).join('')}</div>
        <div class="row"><button class="btn ghost" data-a="pes-rh-modelo">Baixar modelo CSV</button>
          <label class="btn sec" style="cursor:pointer">Importar CSV<input type="file" accept=".csv,text/csv" hidden data-a="pes-rh-csv"></label>
          <button class="btn" data-a="pes-rh-novo">+ Novo ${t.singular}</button></div></div>
      <div class="toolbar">
        <div class="field grow"><label class="lbl" for="rhBusca">Buscar</label><input id="rhBusca" type="search" value="${esc(u.busca)}" data-a="pes-rh-busca" placeholder="Código ou descrição"></div>
        <div class="field"><label class="lbl" for="rhSt">Situação</label><select id="rhSt" data-a="pes-rh-filtro">${[['ativo', 'Ativos'], ['inativo', 'Inativos'], ['todos', 'Todos']].map(([v, l]) => `<option value="${v}" ${v === u.status ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      ${lista.length ? `<div class="tbl-wrap"><table><thead><tr><th>Código</th><th>Descrição</th><th>Situação</th><th class="num">Em uso</th><th></th></tr></thead><tbody>
        ${lista.map(x => { const uso = RH.emUso(u.tab, x.id), ativo = x.status !== 'inativo';
          return `<tr><td class="mono">${esc(x.codigo || '—')}</td><td class="cell-main">${esc(x.nome)}</td><td><span class="pill ${ativo ? 'ok' : 'neutral'}">${ativo ? 'Ativo' : 'Inativo'}</span></td>
          <td class="num">${uso ? `${uso} ${uso > 1 ? 'vínculos' : 'vínculo'}` : '—'}</td>
          <td class="acts"><button class="iconbtn" data-a="pes-rh-editar" data-id="${x.id}" aria-label="Editar">${ICON.editar}</button>
            <button class="btn ${ativo ? 'danger' : 'sec'} sm" data-a="pes-rh-status" data-id="${x.id}">${ativo ? 'Inativar' : 'Reativar'}</button></td></tr>`; }).join('')}
      </tbody></table></div>` : `<div class="empty">${todos.length ? 'Nada encontrado com esses filtros.' : `Nenhum ${t.singular} cadastrado. Use “+ Novo” ou importe o CSV (baixe o modelo).`}</div>`}
      <p class="hint" style="margin-top:10px">${nAtivos} ativo(s) de ${todos.length}. Itens inativos saem das listas de seleção, mas continuam no histórico dos colaboradores e das avaliações.</p></div>`;
  },
  abrirItemRH(id) {
    const tipo = this.ui.rh.tab, t = RH_TABELAS[tipo], x = id ? RH.get(tipo, id) : { status: 'ativo' };
    UI.modal({
      titulo: (id ? 'Editar ' : 'Novo ') + t.singular,
      corpo: `<div class="form-grid">${campo('Código', 'codigo', x.codigo, { dica: tipo === 'centros' ? 'Ex.: 2.05.014 (plano de centros de custo)' : 'Opcional. Ex.: CBO ou código interno' })}${campo('Descrição', 'nome', x.nome, { attrs: 'required' })}</div>
        ${id && RH.emUso(tipo, id) ? `<p class="hint">Em uso por ${RH.emUso(tipo, id)} vínculo(s). A nova descrição passa a aparecer em todos.</p>` : ''}`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar', acao: async m => {
        const d = UI.lerForm(m);
        try { await RH.salvar(tipo, id, { ...d, status: x.status || 'ativo' }); UI.toast(`${t.singular.charAt(0).toUpperCase() + t.singular.slice(1)} salvo`); }
        catch (e) { UI.toast(e.message); return false; }
      } }],
    });
  },
  async alternarStatusRH(id) {
    const tipo = this.ui.rh.tab, t = RH_TABELAS[tipo], x = RH.get(tipo, id), inativar = x.status !== 'inativo', uso = RH.emUso(tipo, id);
    if (inativar && !(await UI.confirmar('Inativar ' + t.singular, `Inativar <b>${esc(RH.rotulo(x))}</b>?${uso ? `<br>${uso} vínculo(s) continuam com este ${t.singular}; ele só deixa de aparecer para novas seleções.` : ''}`, 'Inativar', true))) return;
    if (!inativar && RH.encontrar(tipo, { nome: x.nome }, id)?.status === 'ativo') return UI.toast('Já existe um item ativo com esta descrição.');
    await RH.alterarStatus(tipo, id, inativar ? 'inativo' : 'ativo'); UI.toast(inativar ? 'Inativado' : 'Reativado');
  },
  async baixarModeloRH() {
    // BOM UTF-8 para o Excel abrir os acentos corretamente; o cabeçalho continua exatamente Categoria,Codigo,Descricao
    await Documento.baixarArquivo('modelo_parametrizacoes_rh.csv', new Blob(['\uFEFF' + RH.modeloCSV()], { type: 'text/csv' }));
  },
  async importarCSVRH(file) {
    const { cabecalho, linhas } = CSV.ler(CSV.decodificar(await file.arrayBuffer()));
    // aceita "Código"/"Descrição" com acento, mas exige as três colunas
    const mapa = {}; cabecalho.forEach(h => { const k = RH.chave(h); if (k === 'CATEGORIA') mapa[h] = 'Categoria'; if (k === 'CODIGO') mapa[h] = 'Codigo'; if (k === 'DESCRICAO') mapa[h] = 'Descricao'; });
    if (Object.values(mapa).length < 3) throw new Error('Cabeçalho inválido. Use exatamente: ' + RH_CSV_CABECALHO.join(','));
    const norm = linhas.map(l => Object.fromEntries(Object.entries(l).filter(([k]) => mapa[k]).map(([k, v]) => [mapa[k], v])));
    const { plano, erros } = RH.analisarImportacao(norm);
    const cont = a => plano.filter(p => p.acao === a).length, gravar = cont('criar') + cont('atualizar') + cont('reativar');
    const resumo = `<b>${norm.length}</b> linha(s) lidas de ${esc(file.name)}.<br>
      Novos: <b>${cont('criar')}</b> · descrição atualizada: <b>${cont('atualizar')}</b> · reativados: <b>${cont('reativar')}</b><br>
      Ignorados por já existirem: ${cont('existente')} · repetidos no arquivo: ${cont('repetida')}
      ${erros.length ? `<div class="note warn" style="margin-top:10px"><b>${erros.length} linha(s) com erro (não serão importadas):</b><br>${erros.slice(0, 8).map(esc).join('<br>')}${erros.length > 8 ? '<br>…' : ''}</div>` : ''}`;
    if (!gravar) return UI.modal({ titulo: 'Importar CSV', corpo: resumo + '<p>Nada novo para gravar.</p>' });
    if (!(await UI.confirmar('Importar parametrizações de RH', resumo, `Importar ${gravar}`))) return;
    const r = await RH.importar(plano, file.name);
    UI.toast(`Importação concluída: ${r.criar} novo(s), ${r.atualizar} atualizado(s), ${r.reativar} reativado(s).`);
  },

  /* ---------------- PDI: lista (somente pontuação atual) ---------------- */
  renderPdiLista() {
    const lista = this.filtrados();
    const linhas = lista.map(f => {
      const { atual, anterior } = this.ultimas(this.pdiDe(f.id));
      const m = this.media(atual?.notas), mAnt = this.media(anterior?.notas);
      const delta = m != null && mAnt != null ? m - mAnt : null;
      return `<tr class="click" data-a="pdi-abrir" data-id="${f.id}">
        <td><div class="cell-main">${esc(f.nome)}</div><div class="cell-sub">${esc(f.cargo || '')} · ${esc(this.lotacaoNome(f))}</div></td>
        <td><div class="mini-heat">${COMPETENCIAS.map(c => this.hcell(atual?.notas?.[c.id])).join('')}</div></td>
        <td class="num"><span class="mono" style="font-weight:600;font-size:15px">${m != null ? Fmt.num(m, 1) : '—'}</span>
          ${delta != null && Math.abs(delta) >= 0.05 ? `<div class="delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '▲' : '▼'} ${Fmt.num(Math.abs(delta), 1)}</div>` : ''}</td>
        <td><span class="cell-sub">${atual ? esc(atual.ciclo) + ' · ' + Fmt.data(atual.data) : 'Não avaliado'}</span>${atual?.objetivo === 'promocao' ? `<div><span class="pill info">Promoção → ${esc(atual.cargoAlvo || '')}</span></div>` : ''}</td>
      </tr>`;
    }).join('');
    return `<div class="panel">
      ${this.filtrosHTML()}
      <div class="row between" style="margin-bottom:10px">
        <div class="legend-heat">Escala: ${[1, 2, 3, 4, 5].map(n => `${this.hcell(n)} ${NIVEIS[n]}`).join(' ')}</div>
        <span class="hint">Meta padrão: nível ${META_PADRAO} (${NIVEIS[META_PADRAO]})</span>
      </div>
      ${lista.length ? `<div class="tbl-wrap"><table><thead><tr><th>Colaborador</th>
        <th data-label="Competências (Fin · Dados · Com · Lid · Dec · Org · Inf)"><div class="mini-heat">${COMPETENCIAS.map(c => `<span style="min-width:30px;text-align:center" title="${esc(c.nome)}">${c.curto}</span>`).join('')}</div></th>
        <th class="num">Média atual</th><th>Último ciclo</th></tr></thead><tbody>${linhas}</tbody></table></div>`
        : `<div class="empty">Nenhum colaborador com esses filtros.</div>`}
    </div>
    <div class="panel"><h2>O que se espera de cada competência</h2><p class="sub">Referência usada nas avaliações e no parecer entregue ao colaborador.</p>
      <div class="grid g3">${COMPETENCIAS.map(c => `<div class="comp-card"><h4>${esc(c.nome)}</h4><p>${esc(c.descricao)}</p></div>`).join('')}</div></div>`;
  },

  /* ---------------- PDI: visão detalhada ---------------- */
  renderPdiDetalhe(id) {
    const f = Repo.get('funcionarios', id); if (!f) { this.ui.pdiSel = null; return this.render(); }
    const pdi = this.pdiDe(id), { atual, anterior, todas } = this.ultimas(pdi);
    const m = this.media(atual?.notas), mAnt = this.media(anterior?.notas), delta = m != null && mAnt != null ? m - mAnt : null;
    const meta = c => pdi.metas?.[c.id] || META_PADRAO;
    const ord = atual ? COMPETENCIAS.map(c => ({ c, n: atual.notas[c.id] || 0 })).sort((a, b) => b.n - a.n) : [];
    const fortes = ord.filter(x => x.n >= 4).slice(0, 3), focos = ord.slice().reverse().filter(x => x.n < meta(x.c)).slice(0, 3);
    const podeAv = Auth.can('pdi.avaliar');
    const heat = `<div class="tbl-wrap" style="border:0"><table class="heat"><thead><tr><th></th>${todas.map(a => `<th title="${esc(a.parecer || '')}">${esc(a.ciclo)}<br><span style="font-weight:400">${Fmt.data(a.data)}</span>${a.objetivo === 'promocao' ? `<br><span class="pill info" style="font-size:9.5px">promoção</span>` : ''}</th>`).join('')}<th>Meta</th></tr></thead>
      <tbody>${COMPETENCIAS.map(c => `<tr><th class="rowh">${esc(c.nome)}</th>${todas.map(a => `<td>${this.hcell(a.notas?.[c.id])}</td>`).join('')}<td><span class="hcell h0" style="color:var(--ink)">${meta(c)}</span></td></tr>`).join('')}
      <tr><th class="rowh">Média</th>${todas.map(a => `<td><span class="mono" style="font-weight:600">${Fmt.num(this.media(a.notas), 1)}</span></td>`).join('')}<td></td></tr></tbody></table></div>`;
    const plano = (pdi.plano || []);
    return `
      <div class="crumbs"><button data-a="pdi-voltar">← PDI</button><span>/</span><span>${esc(f.nome)}</span></div>
      <div class="detail-head"><div><div class="code">PDI · ${esc(this.cargoNome(f))} · ${esc(this.lotacaoNome(f))}</div><h1>${esc(f.nome)}</h1>
        ${atual ? `<div class="row" style="margin-top:6px">${atual.objetivo === 'promocao' ? `<span class="pill info">Análise para promoção · cargo alvo: ${esc(atual.cargoAlvo || '—')}</span>` : '<span class="pill neutral">Análise recorrente</span>'}</div>` : ''}</div>
        <div class="row">${podeAv ? `<button class="btn sec" data-a="pdi-avaliar" data-id="${id}">+ Nova avaliação</button>` : ''}
          <button class="btn" data-a="pdi-parecer" data-id="${id}" ${atual ? '' : 'disabled'}>Imprimir parecer</button></div></div>
      ${!atual ? `<div class="panel"><div class="empty">Este colaborador ainda não foi avaliado.${podeAv ? ' Clique em “Nova avaliação” para registrar o primeiro ciclo.' : ''}</div></div>` : `
      <div class="grid g3">
        <div class="panel"><div class="lbl">Pontuação atual</div><div class="row" style="align-items:baseline;gap:10px"><span class="score-big">${Fmt.num(m, 1)}</span><span class="muted">de 5</span>
          ${delta != null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Fmt.num(Math.abs(delta), 1)} vs. ciclo anterior</span>` : ''}</div>
          <p class="hint" style="margin-top:8px">${esc(atual.ciclo)} · avaliado em ${Fmt.data(atual.data)}</p></div>
        <div class="panel"><div class="lbl">Pontos fortes</div>${fortes.length ? fortes.map(x => `<div class="row" style="margin-top:6px">${this.hcell(x.n)}<span>${esc(x.c.nome)}</span></div>`).join('') : '<p class="hint">Nenhuma competência em nível 4 ou 5 ainda.</p>'}</div>
        <div class="panel"><div class="lbl">Foco de desenvolvimento</div>${focos.length ? focos.map(x => `<div class="row" style="margin-top:6px">${this.hcell(x.n)}<span>${esc(x.c.nome)}</span><span class="hint">meta ${meta(x.c)}</span></div>`).join('') : '<p class="hint">Todas as competências atingiram a meta.</p>'}</div>
      </div>
      <div class="panel"><div class="row between"><div><h2>Evolução por competência</h2><p class="sub">Mapa de calor: cada coluna é um ciclo de avaliação; quanto mais escuro, mais alto o nível.</p></div>
        <div class="legend-heat">${[1, 2, 3, 4, 5].map(n => this.hcell(n)).join('')}</div></div>${heat}</div>
      <div class="panel"><h2>Plano de ação</h2><p class="sub">Ações combinadas com o colaborador para as competências em foco.</p>
        ${plano.length ? `<div class="tbl-wrap"><table><thead><tr><th>Competência</th><th>Ação</th><th>Prazo</th><th>Status</th>${podeAv ? '<th></th>' : ''}</tr></thead><tbody>
          ${plano.map(p => `<tr><td>${esc(COMPETENCIAS.find(c => c.id === p.competencia)?.nome || '—')}</td><td>${esc(p.acao)}</td><td>${podeAv ? `<input type="date" id="prazo_${p.id}" class="prazo-acao" value="${esc(p.prazo || '')}" data-a="plano-prazo" data-id="${id}" data-p="${p.id}" aria-label="Prazo da ação" style="min-width:150px">` : `<span class="mono">${Fmt.data(p.prazo)}</span>`}${p.status !== 'Concluída' && p.prazo && p.prazo < Datas.hojeISO() ? ' <span class="pill bad">atrasada</span>' : ''}</td>
          <td>${podeAv ? `<select data-a="plano-status" data-id="${id}" data-p="${p.id}" aria-label="Status da ação">${['Pendente', 'Em andamento', 'Concluída'].map(s => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select>` : `<span class="pill ${p.status === 'Concluída' ? 'ok' : p.status === 'Em andamento' ? 'info' : 'neutral'}">${esc(p.status)}</span>`}</td>
          ${podeAv ? `<td class="acts"><button class="iconbtn" data-a="plano-editar" data-id="${id}" data-p="${p.id}" aria-label="Editar ação">${ICON.editar}</button><button class="iconbtn" data-a="plano-del" data-id="${id}" data-p="${p.id}" aria-label="Remover ação">${ICON.lixo}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhuma ação cadastrada.</div>'}
        ${podeAv ? `<div class="row" style="margin-top:12px"><button class="btn sec sm" data-a="plano-novo" data-id="${id}">+ Adicionar ação</button><button class="btn ghost sm" data-a="plano-sugerir" data-id="${id}">Sugerir ações para os focos</button></div>` : ''}
      </div>
      ${atual.parecer ? `<div class="panel"><h2>Parecer do avaliador</h2><p style="white-space:pre-wrap;margin:8px 0 0">${esc(atual.parecer)}</p></div>` : ''}`}
      <div class="panel"><h2>Competências e nível atual</h2><div class="grid g2" style="margin-top:12px">${COMPETENCIAS.map(c => {
        const n = atual?.notas?.[c.id]; const com = atual?.comentarios?.[c.id];
        return `<div class="comp-card"><div class="row between"><h4>${esc(c.nome)}</h4>${n ? `<span class="row" style="gap:6px">${this.hcell(n)}<span class="hint">${NIVEIS[n]}</span></span>` : ''}</div><p>${esc(c.descricao)}</p>${com ? `<p style="margin-top:8px;color:var(--ink)"><b>Comentário:</b> ${esc(com)}</p>` : ''}</div>`;
      }).join('')}</div></div>`;
  },

  /* ---------------- avaliação ---------------- */
  abrirAvaliacao(id) {
    const f = Repo.get('funcionarios', id), pdi = this.pdiDe(id), { atual } = this.ultimas(pdi);
    const hoje = Datas.hoje(), cicloPadrao = `${hoje.getFullYear()} · ${hoje.getMonth() < 6 ? '1º' : '2º'} semestre`;
    const notas = { ...(atual?.notas || {}) };
    const cargosAlvo = RH.ativos('cargos').filter(c => c.id !== f.cargoId);
    const corpo = `<div class="form-grid">${campo('Ciclo', 'ciclo', cicloPadrao)}${campo('Data da avaliação', 'data', Datas.hojeISO(), { tipo: 'date' })}
        <fieldset class="field full objetivo"><legend class="lbl">Objetivo da análise</legend>
          <div class="row" style="gap:18px"><label class="check"><input type="radio" name="objetivo" value="recorrente" checked> Análise recorrente</label>
          <label class="check"><input type="radio" name="objetivo" value="promocao"> Promoção</label></div></fieldset>
        <div class="field full" id="boxCargoAlvo" hidden><label class="lbl" for="f_cargoAlvo">Cargo alvo</label>
          <select id="f_cargoAlvo" name="cargoAlvoId"><option value="">${cargosAlvo.length ? 'Selecione o cargo pretendido…' : 'Nenhum cargo ativo cadastrado'}</option>${cargosAlvo.map(c => `<option value="${c.id}">${esc(RH.rotulo(c))}</option>`).join('')}</select>
          <span class="hint" style="margin-top:4px">Cargo atual: ${esc(this.cargoNome(f) || 'não informado')}.</span></div></div>
      <p class="hint" style="margin:12px 0 4px">As notas vêm preenchidas com o ciclo anterior. 1 Inicial · 2 Em desenvolvimento · 3 Proficiente · 4 Avançado · 5 Referência</p>
      ${COMPETENCIAS.map(c => `<div class="rate-row"><div><b>${esc(c.nome)}</b><div class="hint">${esc(c.descricao)}</div>
          <input type="text" name="comentarios.${c.id}" placeholder="Comentário (opcional)" style="margin-top:6px" aria-label="Comentário sobre ${esc(c.nome)}"></div>
        <div><div class="rate" data-comp="${c.id}">${[1, 2, 3, 4, 5].map(n => `<button type="button" class="${notas[c.id] === n ? 'on h' + n : ''}" data-n="${n}" aria-label="${c.nome}: ${NIVEIS[n]}">${n}</button>`).join('')}</div>
          <div class="hint" data-lvl="${c.id}" style="margin-top:4px;text-align:right">${notas[c.id] ? NIVEIS[notas[c.id]] : 'Sem nota'}</div></div></div>`).join('')}
      ${campo('Parecer geral (aparece no documento do colaborador)', 'parecer', '', { tipo: 'textarea', full: true })}`;
    UI.modal({
      titulo: 'Avaliação PDI · ' + f.nome, largo: true, corpo,
      aoAbrir: m => m.addEventListener('click', e => {
        // regra condicional: "Promoção" exibe o campo Cargo alvo
        if (e.target.name === 'objetivo') { const promo = e.target.value === 'promocao'; $('#boxCargoAlvo', m).hidden = !promo; if (!promo) $('#f_cargoAlvo', m).value = ''; return; }
        const b = e.target.closest('.rate button'); if (!b) return;
        const comp = b.parentElement.dataset.comp, n = +b.dataset.n; notas[comp] = n;
        $$('button', b.parentElement).forEach(x => x.className = +x.dataset.n === n ? 'on h' + n : '');
        $(`[data-lvl="${comp}"]`, m).textContent = NIVEIS[n];
      }),
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, {
        rotulo: 'Salvar avaliação', acao: async m => {
          const d = UI.lerForm(m), objetivo = $('[name="objetivo"]:checked', m)?.value || 'recorrente';
          if (COMPETENCIAS.some(c => !notas[c.id])) { UI.toast('Dê nota para as 7 competências.'); return false; }
          if (objetivo === 'promocao' && !d.cargoAlvoId) { UI.toast('Selecione o cargo alvo da promoção.'); return false; }
          const alvo = objetivo === 'promocao' ? RH.get('cargos', d.cargoAlvoId) : null;
          const av = { id: uid(), ciclo: d.ciclo, data: d.data, avaliador: Auth.id, objetivo, cargoAtual: this.cargoNome(f), ...(alvo ? { cargoAlvoId: alvo.id, cargoAlvo: alvo.nome } : {}),
            notas: { ...notas }, comentarios: Object.fromEntries(Object.entries(d.comentarios || {}).filter(([, v]) => v)), parecer: d.parecer };
          await Repo.salvar('pdi', id, { ...pdi, avaliacoes: [...(pdi.avaliacoes || []), av] }, { modulo: 'pdi', rotulo: f.nome + ' · ' + d.ciclo });
          UI.toast('Avaliação registrada');
        }
      }],
    });
  },
  /** Nova ação ou edição de uma ação existente (competência, texto e prazo). */
  abrirAcao(id, sugestao, acaoId = null) {
    const pdi = this.pdiDe(id), atual = acaoId ? (pdi.plano || []).find(p => p.id === acaoId) : null;
    const v = atual || { competencia: sugestao?.competencia || '', acao: sugestao?.acao || '', prazo: Datas.iso(Datas.addMeses(Datas.hoje(), 3)) };
    UI.modal({
      titulo: atual ? 'Editar ação do plano' : 'Nova ação do plano',
      corpo: `<div class="form-grid">${campo('Competência', 'competencia', v.competencia, { opcoes: COMPETENCIAS.map(c => [c.id, c.nome]) })}${campo('Prazo', 'prazo', v.prazo, { tipo: 'date' })}${campo('Ação', 'acao', v.acao, { tipo: 'textarea', full: true })}</div>`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: atual ? 'Salvar' : 'Adicionar', acao: async m => {
        const d = UI.lerForm(m); if (!d.acao) { UI.toast('Descreva a ação.'); return false; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.prazo || '')) { UI.toast('Informe um prazo válido.'); return false; }
        const fresco = this.pdiDe(id); // relê: outra edição pode ter chegado enquanto o modal estava aberto
        const plano = atual ? (fresco.plano || []).map(p => p.id === acaoId ? { ...p, ...d } : p) : [...(fresco.plano || []), { id: uid(), ...d, status: 'Pendente' }];
        await Repo.salvar('pdi', id, { ...fresco, plano }, { modulo: 'pdi', rotulo: Repo.get('funcionarios', id)?.nome + ' · plano', detalhe: atual ? 'Ação editada' : 'Ação adicionada' });
      } }],
    });
  },
  /** Atualiza só o prazo de uma ação (input de data na tabela; dispara no change). */
  async salvarPrazo(id, acaoId, prazo) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(prazo || '')) { UI.toast('Data inválida: o prazo não foi alterado.'); return App.render(); }
    const pdi = this.pdiDe(id), atual = (pdi.plano || []).find(p => p.id === acaoId);
    if (!atual || atual.prazo === prazo) return;
    await Repo.salvar('pdi', id, { ...pdi, plano: pdi.plano.map(p => p.id === acaoId ? { ...p, prazo } : p) }, { modulo: 'pdi', rotulo: Repo.get('funcionarios', id)?.nome + ' · plano', detalhe: `Prazo: ${Fmt.data(atual.prazo)} → ${Fmt.data(prazo)}` });
    UI.toast('Prazo atualizado para ' + Fmt.data(prazo));
  },
  async sugerirAcoes(id) {
    const pdi = this.pdiDe(id), { atual } = this.ultimas(pdi); if (!atual) return;
    const focos = COMPETENCIAS.filter(c => (atual.notas[c.id] || 0) < (pdi.metas?.[c.id] || META_PADRAO)).sort((a, b) => atual.notas[a.id] - atual.notas[b.id]).slice(0, 3);
    if (!focos.length) return UI.toast('Todas as competências já estão na meta.');
    const prazo = Datas.iso(Datas.addMeses(Datas.hoje(), 3));
    const novas = focos.map(c => ({ id: uid(), competencia: c.id, acao: c.acoes[0], prazo, status: 'Pendente' }));
    await Repo.salvar('pdi', id, { ...pdi, plano: [...(pdi.plano || []), ...novas] }, { modulo: 'pdi', rotulo: Repo.get('funcionarios', id)?.nome + ' · plano' });
    UI.toast(novas.length + ' ações sugeridas adicionadas — ajuste o texto e os prazos se precisar.');
  },

  /* ---------------- parecer imprimível ---------------- */
  parecer(id) {
    const f = Repo.get('funcionarios', id), pdi = this.pdiDe(id), { atual, anterior, todas } = this.ultimas(pdi);
    const primeiro = (f.nome || '').split(' ')[0];
    const m = this.media(atual.notas), mAnt = this.media(anterior?.notas);
    const meta = c => pdi.metas?.[c.id] || META_PADRAO;
    const ord = COMPETENCIAS.map(c => ({ c, n: atual.notas[c.id] })).sort((a, b) => b.n - a.n);
    const fortes = ord.filter(x => x.n >= 4).slice(0, 3), focos = ord.slice().reverse().filter(x => x.n < meta(x.c)).slice(0, 3);
    const evol = anterior ? COMPETENCIAS.map(c => ({ c, d: (atual.notas[c.id] || 0) - (anterior.notas?.[c.id] || 0) })).filter(x => x.d > 0) : [];
    const cel = n => `<span class="c h${n || 0}">${n || '–'}</span>`;
    const corpo = `${Documento.cabecalho('Parecer de Desenvolvimento (PDI)', `${f.nome} · ${f.cargo || ''}`)}
      <p>Olá, <b>${esc(primeiro)}</b>!</p>
      <p>Este é o seu parecer do ciclo <b>${esc(atual.ciclo)}</b>. Ele mostra onde você já se destaca e onde vale concentrar energia nos próximos meses. A ideia é simples: reconhecer o que está funcionando e combinar passos práticos para você crescer.</p>
      ${atual.objetivo === 'promocao' ? `<div class="box"><b>Objetivo desta análise: promoção.</b> Esta avaliação considera sua preparação para o cargo de <b>${esc(atual.cargoAlvo || '')}</b>${atual.cargoAtual ? ` (cargo atual: ${esc(atual.cargoAtual)})` : ''}. As competências abaixo mostram o que já sustenta essa mudança e o que ainda precisa ser desenvolvido.</div>` : ''}
      <div style="display:flex;gap:30px;align-items:center;margin:14px 0">
        <div><div class="big">${Fmt.num(m, 1)}</div><div style="font-size:11px;color:#585E7F">pontuação média (de 5)</div></div>
        ${mAnt != null ? `<div><div class="big" style="font-size:22px;color:${m >= mAnt ? '#1D7A4E' : '#B63A2F'}">${m >= mAnt ? '+' : ''}${Fmt.num(m - mAnt, 1)}</div><div style="font-size:11px;color:#585E7F">em relação ao ciclo anterior</div></div>` : ''}
        <div style="font-size:11px;color:#585E7F">Escala: 1 Inicial · 2 Em desenvolvimento · 3 Proficiente · 4 Avançado · 5 Referência</div>
      </div>
      <h2>Sua evolução</h2>
      <table class="heat"><thead><tr><th></th>${todas.map(a => `<th>${esc(a.ciclo)}</th>`).join('')}<th>Meta</th></tr></thead>
      <tbody>${COMPETENCIAS.map(c => `<tr><th class="r">${esc(c.nome)}</th>${todas.map(a => `<td>${cel(a.notas?.[c.id])}</td>`).join('')}<td>${cel(0).replace('–', meta(c))}</td></tr>`).join('')}</tbody></table>
      ${evol.length ? `<p style="margin-top:10px">Você evoluiu em <b>${evol.map(x => esc(x.c.nome)).join(', ')}</b> desde o último ciclo. Continue assim!</p>` : ''}
      <h2>Onde você se destaca</h2>
      ${fortes.length ? fortes.map(x => `<div class="box ok"><h3>${esc(x.c.nome)} <span class="pill">${NIVEIS[x.n]}</span></h3><p style="margin:4px 0 0">${esc(x.c.forte)}</p>${atual.comentarios?.[x.c.id] ? `<p style="margin:4px 0 0"><i>“${esc(atual.comentarios[x.c.id])}”</i></p>` : ''}</div>`).join('') : '<p>Neste ciclo nenhuma competência chegou ao nível Avançado — o plano abaixo é o caminho para chegar lá.</p>'}
      <h2>Seu foco para o próximo ciclo</h2>
      ${focos.length ? focos.map(x => `<div class="box foco"><h3>${esc(x.c.nome)} <span class="pill">hoje: ${NIVEIS[x.n]} · meta: ${NIVEIS[meta(x.c)]}</span></h3>
        <p style="margin:4px 0">${esc(x.c.descricao)}</p>${atual.comentarios?.[x.c.id] ? `<p style="margin:4px 0"><i>“${esc(atual.comentarios[x.c.id])}”</i></p>` : ''}
        <b style="font-size:11.5px">Sugestões práticas:</b><ul>${x.c.acoes.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>`).join('') : '<p>Você atingiu a meta em todas as competências. Vamos conversar sobre novos desafios!</p>'}
      ${(pdi.plano || []).filter(p => p.status !== 'Concluída').length ? `<h2>Plano de ação combinado</h2><table><thead><tr><th>Competência</th><th>Ação</th><th>Prazo</th><th>Status</th></tr></thead><tbody>
        ${pdi.plano.filter(p => p.status !== 'Concluída').map(p => `<tr><td>${esc(COMPETENCIAS.find(c => c.id === p.competencia)?.nome || '')}</td><td>${esc(p.acao)}</td><td>${Fmt.data(p.prazo)}</td><td>${esc(p.status)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${atual.parecer ? `<h2>Mensagem do seu avaliador</h2><p style="white-space:pre-wrap">${esc(atual.parecer)}</p>` : ''}
      <div class="sign"><div>Colaborador(a): ${esc(f.nome)}</div><div>Avaliador(a)</div></div>
      <div class="foot">Esposende · Sempre presente na vida da gente. — Documento gerado pelo Painel de Gestão</div>`;
    const nome = 'Parecer_PDI_' + (f.nome || 'colaborador').replace(/\s+/g, '_') + '_' + atual.ciclo.replace(/\W+/g, '');
    Documento.previa('Parecer PDI · ' + f.nome, Documento.montar('Parecer PDI · ' + f.nome, corpo), nome);
  },

  /* ---------------- eventos ---------------- */
  async acao(a, el, ev) {
    const id = el.dataset.id, u = this.ui;
    switch (a) {
      case 'pes-aba': u.aba = el.dataset.v; u.pdiSel = null; return App.render();
      case 'pes-filtro': u[el.dataset.k] = el.value; return App.render();
      case 'func-novo': return this.abrirForm(null);
      case 'pes-rh-tab': u.rh.tab = el.dataset.v; return App.render();
      case 'pes-rh-novo': return this.abrirItemRH(null);
      case 'pes-rh-editar': return this.abrirItemRH(id);
      case 'pes-rh-status': return this.alternarStatusRH(id);
      case 'pes-rh-modelo': return this.baixarModeloRH();
      case 'folha-params': return Folha.abrirParametros();
      case 'func-editar': if (ev.target.closest('[data-a="sal-toggle"]')) return; return this.abrirForm(id);
      case 'sal-toggle': ev.stopPropagation(); u.revelados.has(id) ? u.revelados.delete(id) : u.revelados.add(id); return App.render();
      case 'sal-todos': u.verSalarios = !u.verSalarios; u.revelados.clear(); return App.render();
      case 'pdi-abrir': u.pdiSel = id; return App.render();
      case 'pdi-voltar': u.pdiSel = null; return App.render();
      case 'pdi-avaliar': return this.abrirAvaliacao(id);
      case 'pdi-parecer': return this.parecer(id);
      case 'plano-novo': return this.abrirAcao(id);
      case 'plano-editar': return this.abrirAcao(id, null, el.dataset.p);
      case 'plano-sugerir': return this.sugerirAcoes(id);
      case 'plano-del': { const pdi = this.pdiDe(id); return Repo.salvar('pdi', id, { ...pdi, plano: pdi.plano.filter(p => p.id !== el.dataset.p) }, { modulo: 'pdi', rotulo: Repo.get('funcionarios', id)?.nome + ' · plano' }); }
    }
  },
  async mudanca(a, el) {
    if (a === 'pes-filtro') { this.ui[el.dataset.k] = el.value; return App.render(); }
    if (a === 'pes-rh-filtro') { this.ui.rh.status = el.value; return App.render(); }
    if (a === 'pes-rh-csv') { const f = el.files[0]; el.value = ''; if (f) try { await this.importarCSVRH(f); } catch (e) { UI.toast(e.message); } return; }
    if (a === 'plano-prazo') return this.salvarPrazo(el.dataset.id, el.dataset.p, el.value);
    if (a === 'plano-status') { const id = el.dataset.id, pdi = this.pdiDe(id); await Repo.salvar('pdi', id, { ...pdi, plano: pdi.plano.map(p => p.id === el.dataset.p ? { ...p, status: el.value } : p) }, { modulo: 'pdi', rotulo: Repo.get('funcionarios', id)?.nome + ' · plano' }); }
  },
  entrada(a, el) {
    if (a === 'pes-busca') { this.ui.busca = el.value; App.render(); }
    if (a === 'pes-rh-busca') { this.ui.rh.busca = el.value; App.render(); }
  },
};
