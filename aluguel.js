/* =====================================================================
   MÓDULO 3 — MOTOR DE ALUGUEL (fixo × percentual) e PROJEÇÃO DE CUSTOS DE OCUPAÇÃO
   Camadas:
     6 Serviços → MotorAluguel   (vendas previstas no FCX × % do contrato; sincroniza a provisão no FCX)
     7 UI       → ProjecaoOcupacao (aba do Módulo 3 · Contratos de Locação e Outros)

   REGRA: aluguel do mês = MAIOR entre o aluguel mínimo (contrato.valor_atual) e o aluguel
          variável (vendas previstas da loja no mês × contrato.percentual_faturamento).

   VENDAS PREVISTAS DA LOJA: o FCX projeta as vendas da REDE (meta comercial do mês, Parâmetro 1).
     vendas da loja = meta comercial do FCX × participação da loja nas vendas (%)
     • participação: config/participacao_vendas.porLoja (editável); lojas sem valor dividem o
       restante em partes iguais (marcadas como "estimada");
     • ajuste manual do mês: aluguel_projecoes/<AAAA-MM>.vendasManuais[lojaId] (prevalece).

   SINCRONIZAÇÃO COM O FCX (Módulo 4), meses do atual até +3:
     O FCX já tem linhas de aluguel por loja (às vezes divididas entre vários locadores). O motor
     não altera essas linhas: ele mantém UMA linha própria por loja/mês (id mtr-alg-<mês>-<centro>)
     com o valor que falta para o total de aluguel da loja no mês chegar ao Valor Final Projetado.
       • sem nenhuma linha de aluguel da loja no mês → a linha do motor leva o valor final inteiro;
       • linhas já lançadas ≥ valor final → a linha do motor é removida (nada a complementar).
     Contas: 4.10.06 (rua) · 4.10.07.01 (shopping) · 4.10.07.05 (complemento percentual em shopping).
   ===================================================================== */
const ALUGUEL_CONTAS = { rua: '4.10.06', shopping: '4.10.07.01', percentual: '4.10.07.05' };
const ALUGUEL_CONTAS_PADRAO = { '4.10.06': '4.10.06 – (-) Aluguel de Loja de Rua', '4.10.07.01': '4.10.07.01 – Aluguel Mensal Shopping', '4.10.07.05': '4.10.07.05 – Aluguel Percentual' };
const MOTOR_ALG_PREFIXO = 'mtr-alg-';
const ALG_POR_PAGINA = 25;

/* ============================ 6. SERVIÇOS ============================ */
const MotorAluguel = {
  r2: n => Math.round((Number(n) + Number.EPSILON) * 100) / 100,
  mesAtual: () => Datas.hojeISO().slice(0, 7),
  somaMes(mes, n) { const [y, m] = mes.split('-').map(Number), d = new Date(y, m - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); },
  meses() { return [-1, 0, 1, 2, 3, 4, 5].map(i => this.somaMes(this.mesAtual(), i)); },
  mesesSync() { return [0, 1, 2, 3].map(i => this.somaMes(this.mesAtual(), i)); },

  /** Participação de cada loja ativa nas vendas da rede (%, soma 100). */
  participacoes() {
    const ativas = Repo.todos('lojas').filter(l => l.ativa), cfg = Repo.get('config', 'participacao_vendas')?.porLoja || {};
    const expl = ativas.filter(l => cfg[l.id] != null && cfg[l.id] !== ''), resto = Math.max(0, 100 - expl.reduce((a, l) => a + Number(cfg[l.id]), 0));
    const sem = ativas.filter(l => !expl.includes(l)), cada = sem.length ? resto / sem.length : 0;
    const mapa = {}, estimadas = new Set();
    expl.forEach(l => { mapa[l.id] = Number(cfg[l.id]); });
    sem.forEach(l => { mapa[l.id] = cada; estimadas.add(l.id); });
    return { mapa, estimadas, soma: Object.values(mapa).reduce((a, v) => a + v, 0), explicitas: expl.length };
  },
  /** Código do centro no formato do FCX ("2.05.014 – 014 - SHOPPING TACARUNA I"). */
  centroFCX(cc, api) { return api.centros().find(x => x.split('–')[0].trim() === cc.codigo) || `${cc.codigo} – ${cc.nome}`; },
  contaFCX(prefixo, api) { return api.contas().find(x => x.split('–')[0].trim() === prefixo) || ALUGUEL_CONTAS_PADRAO[prefixo]; },
  idLinha(mes, cc) { return `${MOTOR_ALG_PREFIXO}${mes}-${cc.codigo.replace(/\W/g, '')}`; },

  /**
   * Cálculo do mês. Retorna null enquanto o motor do FCX não estiver pronto.
   * linhas: { contrato, cc, loja, vendas{valor,origem,pct,estimada}, minimo, pct, variavel, final, acima,
   *           fcx{provisionado, linhas[], motor, complemento}, acao }
   */
  calcular(mes, api = FCX.api()) {
    if (!api) return null;
    const meta = api.vendasPrevistas(mes), part = this.participacoes(), proj = Repo.get('aluguel_projecoes', mes) || {};
    const saidasMes = api.saidas().filter(s => s.date && s.date.startsWith(mes));
    const fimMes = Datas.iso(new Date(+mes.slice(0, 4), +mes.slice(5, 7), 0));
    const linhas = ContratosLocacao.ativos().filter(c => !c.data_inicio || c.data_inicio <= fimMes).map(c => {
      const cc = RH.get('centros', c.loja_id); if (!cc) return null;
      const loja = ContratosLocacao.lojaDoCentro(cc);
      const manual = loja ? proj.vendasManuais?.[loja.id] : null;
      const pctLoja = loja ? part.mapa[loja.id] || 0 : 0;
      const vendas = manual != null && manual !== '' ? { valor: Number(manual), origem: 'manual' } : { valor: this.r2(meta * pctLoja / 100), origem: 'rateio', pct: pctLoja, estimada: loja ? part.estimadas.has(loja.id) : true };
      const minimo = Number(c.valor_atual) || 0, pct = Number(c.percentual_faturamento) || 0;
      const variavel = this.r2(vendas.valor * pct / 100), final = this.r2(Math.max(minimo, variavel));
      // provisões de aluguel já lançadas no FCX para a loja no mês (fora a linha do motor)
      const doCentro = saidasMes.filter(s => (s.centro || '').split('–')[0].trim() === cc.codigo && Object.values(ALUGUEL_CONTAS).includes((s.conta || '').split('–')[0].trim()));
      const motor = doCentro.find(s => String(s.id).startsWith(MOTOR_ALG_PREFIXO)) || null, outras = doCentro.filter(s => s !== motor);
      const provisionado = this.r2(outras.reduce((a, s) => a + (Number(s.valor) || 0), 0));
      const complemento = this.r2(final - provisionado);
      return { contrato: c, cc, loja, vendas, minimo, pct, variavel, final, acima: pct > 0 && variavel > minimo,
        fcx: { provisionado, linhas: outras, motor, complemento: complemento > 0.009 ? complemento : 0, sobra: complemento < -0.009 ? -complemento : 0 } };
    }).filter(Boolean).sort((a, b) => (a.cc.nome || '').localeCompare(b.cc.nome || '', 'pt-BR', { numeric: true }));
    const t = k => this.r2(linhas.reduce((a, l) => a + l[k], 0));
    return { mes, meta, linhas, participacao: part, totais: { minimo: t('minimo'), final: t('final'), adicional: this.r2(t('final') - t('minimo')), acima: linhas.filter(l => l.acima).length, vendas: this.r2(linhas.reduce((a, l) => a + l.vendas.valor, 0)) } };
  },
  /** Linhas a gravar/remover no FCX para o mês (só a linha própria do motor, por loja). */
  plano(r, api) {
    const upserts = [], remover = [], hoje = Datas.hojeISO();
    const desejados = new Set();
    for (const l of r.linhas) {
      const id = this.idLinha(r.mes, l.cc); desejados.add(id);
      if (!l.fcx.complemento) { if (l.fcx.motor) remover.push(l.fcx.motor.id); continue; }
      const shopping = l.loja?.tipo === 'SHOPPING', temOutras = l.fcx.linhas.length > 0;
      const conta = this.contaFCX(shopping ? (temOutras ? ALUGUEL_CONTAS.percentual : ALUGUEL_CONTAS.shopping) : ALUGUEL_CONTAS.rua, api);
      let data = l.fcx.motor?.date || l.fcx.linhas.map(s => s.date).sort()[0] || `${r.mes}-05`;
      if (!l.fcx.motor && r.mes === hoje.slice(0, 7) && data < hoje) data = hoje; // provisão nova não nasce vencida
      upserts.push({ id, date: data, conta, centro: this.centroFCX(l.cc, api), tipo: 'previsto', valor: l.fcx.complemento, fornecedor: l.contrato.locador,
        obs: `Motor de Aluguel (Painel): final ${Fmt.brl(l.final)} = maior entre mínimo ${Fmt.brl(l.minimo)} e ${Fmt.pct(l.pct)} × vendas ${Fmt.brl(l.vendas.valor)}${temOutras ? ` · complemento sobre ${Fmt.brl(l.fcx.provisionado)} já lançados` : ''}` });
    }
    // linhas do motor de contratos que deixaram de existir/ficar ativos
    api.saidas().filter(s => s.date?.startsWith(r.mes) && String(s.id).startsWith(MOTOR_ALG_PREFIXO) && !desejados.has(s.id)).forEach(s => remover.push(s.id));
    return { upserts, remover };
  },
  _timer: null, _rodando: false, ultima: null,
  /** Automação: recalcula e grava no FCX (só o que mudou). Chamada após mudanças em contratos, participação, vendas ou no FCX. */
  agendar(motivo = 'automático') {
    if (!Auth.can('lojas.contratos.editar') || !Auth.can('fcx.editar')) return; // v14: grava no FCX só quem pode modificar o FCX
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.sincronizar(this.mesesSync(), motivo).catch(e => console.warn('Motor de aluguel:', e)), 1200);
  },
  async sincronizar(meses, motivo = 'manual') {
    if (this._rodando || !Auth.can('lojas.contratos.editar') || !Auth.can('fcx.editar')) return null;
    if (!Repo.prontas.has(ContratosLocacao.COL) || !Repo.prontas.has('lojas') || !Repo.prontas.has('rh_centros')) return null;
    const api = FCX.api(); if (!api) { FCX.montar(); return null; }
    this._rodando = true;
    try {
      const res = [];
      for (const mes of meses) {
        const r = this.calcular(mes, api); if (!r) continue;
        const p = this.plano(r, api), n = api.sincronizarSaidas(p.upserts, p.remover);
        res.push({ mes, alteradas: n, linhas: p.upserts.length, total: this.r2(p.upserts.reduce((a, s) => a + s.valor, 0)) });
        if (n) {
          const doc = Repo.get('aluguel_projecoes', mes) || {};
          const { id: _, ...x } = doc;
          await Repo.salvar('aluguel_projecoes', mes, { ...x, mes, sync: { em: new Date().toISOString(), por: Auth.id, motivo, linhasMotor: p.upserts.length, alteradas: n, valorMotor: res.at(-1).total, valorFinal: r.totais.final } },
            { modulo: 'lojas', rotulo: `Motor de aluguel · ${Retaguarda.mesLabel(mes)}`, detalhe: `${n} provisão(ões) de aluguel atualizada(s) no FCX (${motivo})` });
        }
      }
      this.ultima = { em: new Date(), res };
      return res;
    } finally { this._rodando = false; }
  },
};

/* ============================ 7. UI ============================ */
const ProjecaoOcupacao = {
  ui: { mes: '', pagina: 1, soAcima: false },
  _r: null,
  render() {
    if (!Contratos.pode()) return '';
    if (!['lojas', 'rh_centros', ContratosLocacao.COL, 'aluguel_projecoes'].every(c => Repo.prontas.has(c))) return '<div class="panel"><p class="muted">Carregando…</p></div>';
    const u = this.ui; if (!u.mes) u.mes = MotorAluguel.mesAtual();
    const r = MotorAluguel.calcular(u.mes); this._r = r;
    const ed = Auth.can('lojas.contratos.editar');
    const topo = `<div class="row between" style="margin-bottom:14px;align-items:flex-end;gap:12px">
      <div class="toolbar" style="margin:0;flex:1"><div class="field" style="max-width:240px"><label class="lbl" for="algMes">Mês</label><select id="algMes" data-a="alg-f" data-k="mes">${MotorAluguel.meses().map(m => `<option value="${m}" ${m === u.mes ? 'selected' : ''}>${Retaguarda.mesLabel(m)}${m === MotorAluguel.mesAtual() ? ' (atual)' : ''}</option>`).join('')}</select></div>
        <label class="check" style="padding-bottom:9px"><input type="checkbox" data-a="alg-acima" ${u.soAcima ? 'checked' : ''}> Só lojas com variável acima do mínimo</label></div>
      <div class="row">${ed ? `<button class="btn ghost" data-a="alg-participacao">Participação das lojas nas vendas</button><button class="btn sec" data-a="alg-sync">Sincronizar com o FCX</button>` : ''}</div></div>`;
    if (!r) { FCX.montar(); return topo + '<div class="panel"><p class="muted" style="margin:0">Lendo as vendas previstas no motor do FCX…</p></div>'; }
    const doc = Repo.get('aluguel_projecoes', u.mes), sync = doc?.sync, futuro = u.mes >= MotorAluguel.mesAtual(), passado = !futuro;
    const avisos = (!r.meta ? `<div class="note warn" style="margin-bottom:12px">O FCX não tem <b>meta comercial</b> para ${Retaguarda.mesLabel(u.mes)} (FCX → Gerenciar dados → Parâmetros). Sem vendas previstas, todas as lojas ficam no aluguel mínimo${ed ? ', a não ser que você informe as vendas da loja na tabela' : ''}.</div>` : '')
      + (r.participacao.explicitas === 0 && r.meta ? `<div class="note warn" style="margin-bottom:12px">A participação de cada loja nas vendas ainda não foi informada: a meta foi dividida igualmente entre as ${Object.keys(r.participacao.mapa).length} lojas ativas. Ajuste em “Participação das lojas nas vendas”.</div>` : '');
    const t = r.totais;
    const kpis = `<div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Vendas previstas (FCX)</div><div class="v mono">${Fmt.brl0(r.meta)}</div><div class="d">meta comercial da rede · ${Fmt.brl0(t.vendas)} nas lojas com contrato</div></div>
      <div class="kpi"><div class="k">Aluguel mínimo</div><div class="v mono">${Fmt.brl0(t.minimo)}</div><div class="d">${r.linhas.length} contrato(s) ativo(s)</div></div>
      <div class="kpi zona-kpi ${t.acima ? 'warn' : 'ok'}"><div class="k">Variável acima do mínimo</div><div class="v" style="color:var(${t.acima ? '--warn' : '--ink'})">${t.acima}</div><div class="d">adicional de ${Fmt.brl0(t.adicional)} sobre o mínimo</div></div>
      <div class="kpi"><div class="k">Valor final projetado</div><div class="v mono">${Fmt.brl0(t.final)}</div><div class="d">${passado ? 'mês encerrado: não sincroniza' : sync ? `FCX atualizado em ${Fmt.dataHora(sync.em)}` : 'ainda não sincronizado com o FCX'}</div></div></div>`;
    const tabela = r.linhas.length ? `<div class="panel"><h2>Projeção de custos de ocupação · ${Retaguarda.mesLabel(u.mes)}</h2>
        <p class="sub">Aluguel do mês = o maior entre o mínimo do contrato e o % contratual × vendas previstas. As linhas destacadas pagam pelo percentual. A coluna FCX mostra quanto já está lançado para a loja no mês e o que o motor provisiona.</p>
        <div class="tbl-wrap"><table id="algTabela" class="alg"><thead><tr><th>Filial</th><th class="num">Vendas previstas do mês</th><th class="num">Aluguel mínimo</th><th class="num">% contratual</th><th class="num">Valor variável</th><th class="num">Valor final projetado</th><th>FCX (Módulo 4)</th></tr></thead><tbody id="algBody"></tbody></table></div><div id="algPager"></div></div>`
      : `<div class="panel"><div class="empty">Nenhum contrato ativo. Cadastre os contratos (com o % sobre vendas, quando houver) na aba “Contratos e apólices” do Módulo 3.</div></div>`;
    return topo + avisos + kpis + tabela;
  },
  linhaHTML(l, ed, passado) {
    const v = l.vendas, f = l.fcx;
    const fcx = passado ? `<span class="hint">já lançados ${Fmt.brl(f.provisionado + (f.motor?.valor || 0))}</span>`
      : f.complemento ? `<span class="pill info">motor ${Fmt.brl(f.complemento)}</span><div class="cell-sub">${f.linhas.length ? `+ ${Fmt.brl(f.provisionado)} já lançados` : 'linha única do aluguel'}${f.motor && Math.abs(f.motor.valor - f.complemento) > 0.009 ? ' · a atualizar' : !f.motor ? ' · a criar' : ''}</div>`
      : f.sobra ? `<span class="pill neutral">coberto</span><div class="cell-sub">FCX tem ${Fmt.brl(f.provisionado)} (${Fmt.brl(f.sobra)} acima)</div>`
      : `<span class="pill ok">coberto</span><div class="cell-sub">${Fmt.brl(f.provisionado)} lançados</div>`;
    return `<tr class="${l.acima ? 'alg-acima' : ''}">
      <td><div class="cell-main">${esc(l.cc.nome)}</div><div class="cell-sub">${esc(l.loja?.tipo || '—')} · ${esc(l.contrato.locador)}</div></td>
      <td class="num">${ed ? `<input type="number" step="0.01" min="0" class="alg-vendas" id="algV_${l.loja?.id || l.cc.id}" value="${v.origem === 'manual' ? v.valor : ''}" placeholder="${Fmt.num(v.valor, 2)}" data-a="alg-vendas" data-l="${l.loja?.id || ''}" ${l.loja ? '' : 'disabled'} aria-label="Vendas previstas de ${esc(l.cc.nome)}">` : `<b>${Fmt.brl(v.valor)}</b>`}
        <div class="cell-sub">${v.origem === 'manual' ? 'informado para o mês' : !l.loja ? 'loja não encontrada no cadastro' : !l.loja.ativa ? 'loja inativa no cadastro: informe as vendas' : `${Fmt.pct(v.pct || 0, 2)} da meta${v.estimada ? ' (estimada)' : ''}`}</div></td>
      <td class="num">${Fmt.brl(l.minimo)}</td><td class="num">${l.pct ? Fmt.pct(l.pct, 2) : '<span class="hint">só fixo</span>'}</td>
      <td class="num">${l.pct ? `<b style="color:var(${l.acima ? '--warn' : '--ink-soft'})">${Fmt.brl(l.variavel)}</b>` : '<span class="hint">—</span>'}${l.acima ? `<div class="cell-sub" style="color:var(--warn)">+${Fmt.brl(l.variavel - l.minimo)} sobre o mínimo</div>` : ''}</td>
      <td class="num"><b>${Fmt.brl(l.final)}</b><div class="cell-sub">${l.acima ? '<span class="pill warn">percentual</span>' : 'mínimo'}</div></td>
      <td>${fcx}</td></tr>`;
  },
  montar() {
    const tb = $('#algBody'), r = this._r; if (!tb || !r) return;
    const u = this.ui, lista = u.soAcima ? r.linhas.filter(l => l.acima) : r.linhas, ed = Auth.can('lojas.contratos.editar'), passado = u.mes < MotorAluguel.mesAtual();
    const pags = Math.max(1, Math.ceil(lista.length / ALG_POR_PAGINA)); u.pagina = Math.min(Math.max(1, u.pagina), pags);
    const i0 = (u.pagina - 1) * ALG_POR_PAGINA, fatia = lista.slice(i0, i0 + ALG_POR_PAGINA);
    const tpl = document.createElement('template'); tpl.innerHTML = fatia.map(l => this.linhaHTML(l, ed, passado)).join('') || '<tr><td colspan="7"><div class="empty">Nenhuma loja com variável acima do mínimo neste mês.</div></td></tr>';
    const frag = document.createDocumentFragment(); frag.appendChild(tpl.content); tb.replaceChildren(frag);
    UI.rotularTabelas(tb.closest('.tbl-wrap'));
    const pg = $('#algPager');
    if (pg) pg.innerHTML = lista.length > ALG_POR_PAGINA ? `<div class="row between" style="margin-top:10px"><span class="hint">Linhas ${i0 + 1}–${i0 + fatia.length} de ${lista.length}</span><div class="row"><button class="btn sec sm" data-a="alg-pag" data-d="-1" ${u.pagina <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="hint">Página ${u.pagina} de ${pags}</span><button class="btn sec sm" data-a="alg-pag" data-d="1" ${u.pagina >= pags ? 'disabled' : ''}>Próxima ›</button></div></div>` : '';
  },
  afterRender() {
    this.montar();
    // automação: ao abrir/atualizar a projeção de um mês aberto, grava no FCX o que estiver diferente
    if (this._r && this.ui.mes >= MotorAluguel.mesAtual()) MotorAluguel.agendar('projeção aberta');
  },
  abrirParticipacao() {
    const p = MotorAluguel.participacoes(), cfg = Repo.get('config', 'participacao_vendas')?.porLoja || {};
    const lojas = Repo.todos('lojas').filter(l => l.ativa).sort((a, b) => a.codigo.localeCompare(b.codigo));
    const temFat = lojas.some(l => Number(l.faturamentoMedio) > 0);
    UI.modal({
      titulo: 'Participação das lojas nas vendas', largo: true,
      corpo: `<p class="hint" style="margin-top:0">O FCX projeta as vendas da rede (meta comercial). Aqui você define quanto cada loja representa (%). Lojas em branco dividem igualmente o que faltar para 100%.</p>
        <div class="row" style="margin-bottom:10px"><button class="btn sec sm" type="button" data-part="limpar">Limpar (dividir igualmente)</button>${temFat ? '<button class="btn sec sm" type="button" data-part="fat">Usar o faturamento médio do cadastro</button>' : ''}<span class="hint" id="partSoma"></span></div>
        <div class="tbl-wrap"><table class="nolabel"><thead><tr><th>Loja</th><th class="num">Participação (%)</th></tr></thead><tbody>
        ${lojas.map(l => `<tr><td>${esc(l.codigo)} · ${esc(l.nome)}</td><td class="num"><input type="number" step="0.01" min="0" max="100" data-loja="${l.id}" value="${cfg[l.id] ?? ''}" placeholder="${Fmt.num(p.mapa[l.id] || 0, 2)}" style="max-width:120px" aria-label="Participação de ${esc(l.nome)}"></td></tr>`).join('')}</tbody></table></div>`,
      aoAbrir: m => {
        const soma = () => { const v = $$('input[data-loja]', m).reduce((a, i) => a + (Number(i.value) || 0), 0); $('#partSoma', m).textContent = `Informado: ${Fmt.num(v, 2)}%${v > 100.001 ? ' — passa de 100%' : ''}`; };
        m.addEventListener('input', soma); soma();
        m.addEventListener('click', e => {
          const b = e.target.closest('[data-part]'); if (!b) return;
          if (b.dataset.part === 'limpar') $$('input[data-loja]', m).forEach(i => { i.value = ''; });
          if (b.dataset.part === 'fat') { const tot = lojas.reduce((a, l) => a + (Number(l.faturamentoMedio) || 0), 0); $$('input[data-loja]', m).forEach(i => { const l = Repo.get('lojas', i.dataset.loja); i.value = tot ? (Math.round((Number(l.faturamentoMedio) || 0) / tot * 10000) / 100) : ''; }); }
          soma();
        });
      },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Salvar participação', acao: async m => {
        const porLoja = {}; $$('input[data-loja]', m).forEach(i => { if (i.value !== '') porLoja[i.dataset.loja] = Number(i.value); });
        const tot = Object.values(porLoja).reduce((a, v) => a + v, 0); if (tot > 100.001) { UI.toast('A soma passa de 100%.'); return false; }
        await Repo.salvar('config', 'participacao_vendas', { porLoja }, { modulo: 'lojas', rotulo: 'Participação das lojas nas vendas' });
        MotorAluguel.agendar('participação alterada');
      } }],
    });
  },
  async salvarVendas(lojaId, valor) {
    const mes = this.ui.mes, doc = Repo.get('aluguel_projecoes', mes) || {}; const { id: _, ...x } = doc;
    const vm = { ...(x.vendasManuais || {}) }; if (valor === '' || valor == null) delete vm[lojaId]; else vm[lojaId] = Number(valor);
    await Repo.salvar('aluguel_projecoes', mes, { ...x, mes, vendasManuais: vm }, { modulo: 'lojas', rotulo: `Vendas previstas · ${Repo.get('lojas', lojaId)?.nome || lojaId} · ${Retaguarda.mesLabel(mes)}` });
    MotorAluguel.agendar('vendas da loja ajustadas');
  },
  async acao(a, el) {
    const u = this.ui;
    if (a === 'alg-participacao') return this.abrirParticipacao();
    if (a === 'alg-pag') { u.pagina += Number(el.dataset.d); return this.montar(); }
    if (a === 'alg-sync') {
      if (u.mes < MotorAluguel.mesAtual()) return UI.toast('Mês encerrado: o motor só atualiza o FCX do mês atual em diante.');
      UI.toast('Sincronizando com o FCX…');
      const res = await MotorAluguel.sincronizar([u.mes], 'manual');
      if (!res) return UI.toast('O FCX ainda está carregando. Tente de novo em instantes.');
      const x = res[0]; UI.toast(x.alteradas ? `FCX atualizado: ${x.alteradas} provisão(ões) de aluguel.` : 'O FCX já estava em dia.'); return App.render();
    }
  },
  mudanca(a, el) {
    if (a === 'alg-f') { this.ui[el.dataset.k] = el.value; this.ui.pagina = 1; return App.render(); }
    if (a === 'alg-acima') { this.ui.soAcima = el.checked; this.ui.pagina = 1; return this.montar(); }
    if (a === 'alg-vendas') return this.salvarVendas(el.dataset.l, el.value);
  },
};
