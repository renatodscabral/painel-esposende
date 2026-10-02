/* =====================================================================
   MÓDULO 4 — RETAGUARDA FINANCEIRA · telas novas (camada 7, UI)
   Estende o objeto Retaguarda (retaguarda.js) com a aba
     • IEO · Ranking — Índice de Eficiência Operacional, pódio, alertas, laudos e WhatsApp
   A lógica de negócio está em financeiro.js (IEO, Laudo). Conciliação bancária (OFX) e DFC
   foram para o Módulo 3 (fcx-dfc.js).
   ===================================================================== */
Object.assign(Retaguarda.ui, {
  ieo: { mes: '', zona: '', verTodas: false },
});

/* Rótulos curtos (singular/plural) para o "fator crítico" da mensagem de WhatsApp */
const IEO_ROTULO_CURTO = {
  falta_isolada: ['Falta de caixa', 'Faltas de caixa'],
  quebra_reincidente: ['Quebra de caixa reincidente', 'Quebras de caixa reincidentes'],
  div_recebimentos: ['Divergência de recebimento', 'Divergências de recebimento'],
  erro_pix: ['Erro de lançamento/baixa de PIX', 'Erros de lançamento/baixa de PIX'],
  atraso_justificativa: ['Atraso de justificativa', 'Atrasos de justificativa'],
};

Object.assign(Retaguarda, {
  colecoesFin() { return ['ieo_ocorrencias', 'ieo_fechamentos', 'ieo_laudos', 'alertas']; },

  /* =====================================================================
     IEO — Índice de Eficiência Operacional e Ranking
     ===================================================================== */
  mesAtual: () => Datas.hojeISO().slice(0, 7),
  mesAnterior(mes) { const [y, m] = mes.split('-').map(Number); const d = new Date(y, m - 2, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); },
  /** Ranking do mês: usa o fechamento congelado, se existir; senão calcula ao vivo. */
  rankingIEO(mes) {
    const fech = Repo.get('ieo_fechamentos', mes);
    if (fech?.ranking) return { ranking: fech.ranking, fechado: fech };
    const lojas = Repo.todos('lojas').filter(l => l.ativa);
    const ocorrencias = Repo.todos('ieo_ocorrencias').filter(d => d.mes === mes).flatMap(d => (d.itens || []).map(i => ({ ...i, lojaId: d.lojaId })));
    return { ranking: IEO.calcular({ mes, lojas, faltas: this.itensFaltas(), credsystem: this.linhasCS(), ocorrencias, matriz: IEO.matriz(), hoje: Datas.hojeISO() }), fechado: null };
  },
  mesesIEO() { return [...new Set([this.mesAtual(), ...this.mesesCS(), ...this.itensFaltas().map(i => i.data.slice(0, 7)), ...Repo.todos('ieo_fechamentos').map(d => d.id)])].sort().reverse(); },
  alertasAbertos() { return Repo.todos('alertas').filter(a => !a.cienteEm); },
  /** Cria o alerta da loja que entrou na Zona Vermelha no mês corrente (uma vez por loja/mês). */
  async sincronizarAlertas(ranking, mes) {
    if (!Auth.can('retaguarda.ieo.lancar') || mes !== this.mesAtual() || !Repo.prontas.has('alertas')) return;
    this._alertaTentado ||= new Set();
    for (const r of ranking.filter(x => x.zona === 'vermelha')) {
      const id = mes + '_' + r.lojaId; if (Repo.get('alertas', id) || this._alertaTentado.has(id)) continue;
      this._alertaTentado.add(id);
      const l = Repo.get('lojas', r.lojaId);
      await Repo.salvar('alertas', id, { tipo: 'ieo_vermelha', lojaId: r.lojaId, mes, pontos: r.pontos, supervisor: l?.supervisor || '', criadoEm: new Date().toISOString() }, { modulo: 'retaguarda', rotulo: `Alerta IEO · ${this.nomeLoja(r.lojaId)}`, detalhe: `Zona Vermelha com ${r.pontos} pontos` });
    }
  },
  textoAviso(a) {
    const l = Repo.get('lojas', a.lojaId);
    return `Alerta IEO — Zona Vermelha\nLoja ${l ? l.codigo + ' · ' + l.nome : a.lojaId}\nPontuação: ${String(a.pontos).replace('.', ',')} pontos em ${this.mesLabel(a.mes)} (limite crítico: ${IEO.matriz().faixas.vermelha}).\nSupervisor: ${a.supervisor || '—'}\nAção: revisar as ocorrências no Painel de Gestão (Retaguarda Financeira → IEO · Ranking) e agendar visita à loja.`;
  },

  renderIEO() {
    if (!Auth.can('retaguarda.ieo.ver')) return this.bloqueado('IEO', 'Sem permissão para o Índice de Eficiência Operacional.');
    if (!['credsystem', 'faltas', 'lojas'].every(c => Repo.prontas.has(c))) return '<div class="panel"><p class="muted">Calculando pontuação…</p></div>';
    const u = this.ui.ieo, meses = this.mesesIEO(); if (!u.mes) u.mes = this.mesAtual();
    const m = IEO.matriz(), { ranking, fechado } = this.rankingIEO(u.mes), anterior = this.rankingIEO(this.mesAnterior(u.mes)).ranking;
    // só compara com o mês anterior se ele teve movimento (senão todas as lojas empatam em 100)
    const antPos = anterior.some(x => x.deducoes?.length) ? Object.fromEntries(anterior.map(a => [a.lojaId, a.posicao])) : {};
    this._ieoDados = { ranking, mes: u.mes };
    const cont = { verde: 0, amarela: 0, vermelha: 0 }; ranking.forEach(r => cont[r.zona]++);
    const media = ranking.reduce((a, r) => a + r.pontos, 0) / (ranking.length || 1);
    const vermelhas = ranking.filter(r => r.zona === 'vermelha');
    const g = Auth.can.bind(Auth);
    const topo = `<div class="row between" style="margin-bottom:14px">
        <div class="toolbar" style="margin:0;flex:1">
          <div class="field"><label class="lbl" for="ieoMes">Ciclo (mês)</label><select id="ieoMes" data-a="rt-ieo" data-k="mes">${meses.map(x => `<option value="${x}" ${x === u.mes ? 'selected' : ''}>${this.mesLabel(x)}${Repo.get('ieo_fechamentos', x) ? ' · fechado' : ''}</option>`).join('')}</select></div>
          <div class="field"><label class="lbl" for="ieoZona">Zona</label><select id="ieoZona" data-a="rt-ieo" data-k="zona"><option value="">Todas</option>${Object.entries(IEO.ZONAS).map(([k, z]) => `<option value="${k}" ${k === u.zona ? 'selected' : ''}>${z.rotulo}</option>`).join('')}</select></div></div>
        <div class="row">${g('retaguarda.ieo.matriz') ? '<button class="btn sec" data-a="rt-ieo-matriz">Matriz de deduções</button>' : ''}${g('retaguarda.ieo.lancar') && !fechado ? '<button class="btn sec" data-a="rt-ieo-ocorrencia">+ Ocorrência</button>' : ''}
          ${g('retaguarda.ieo.fechar') ? (fechado ? '<button class="btn ghost" data-a="rt-ieo-reabrir">Reabrir ciclo</button>' : `<button class="btn" data-a="rt-ieo-fechar">Fechar ciclo</button>`) : ''}</div></div>`;
    const alertas = this.alertasAbertos().filter(a => a.mes === u.mes);
    const banner = vermelhas.length ? `<div class="alerta-critico" role="alert"><div class="ic">${ICON.alerta}</div><div style="flex:1;min-width:0"><b>${vermelhas.length} loja${vermelhas.length > 1 ? 's' : ''} em Zona Vermelha (abaixo de ${m.faixas.vermelha} pontos)</b>
        <div class="alerta-lista">${vermelhas.map(r => `<div class="row between" style="gap:8px;padding:6px 0;border-top:1px solid rgba(0,0,0,.08)"><span>${esc(r.codigo)} · ${esc(r.nome)} (${Fmt.num(r.pontos, 0)} pts${Repo.get('lojas', r.lojaId)?.supervisor ? ' · sup. ' + esc(Repo.get('lojas', r.lojaId).supervisor) : ''})</span>${this.botaoWhats(r, 'sm')}</div>`).join('')}</div>
        ${alertas.length ? `<div class="hint" style="color:inherit;opacity:.85">${alertas.length} alerta(s) aguardando ciência da supervisão.</div>` : ''}</div>
        ${alertas.length ? `<button class="btn sm" data-a="rt-ieo-alertas">Ver alertas</button>` : ''}</div>` : '';
    const kpis = `<div class="grid g4" style="margin-bottom:16px">
      <div class="kpi"><div class="k">Média da rede</div><div class="v">${Fmt.num(media, 1)}</div><div class="d">${ranking.length} lojas ativas · início com ${m.pontosIniciais} pontos</div></div>
      <div class="kpi zona-kpi ok"><div class="k">Zona Verde</div><div class="v">${cont.verde}</div><div class="d">${m.faixas.verde} pontos ou mais</div></div>
      <div class="kpi zona-kpi warn"><div class="k">Zona Amarela</div><div class="v">${cont.amarela}</div><div class="d">de ${m.faixas.vermelha} a ${m.faixas.verde - 1}</div></div>
      <div class="kpi zona-kpi bad"><div class="k">Zona Vermelha</div><div class="v">${cont.vermelha}</div><div class="d">abaixo de ${m.faixas.vermelha}</div></div></div>`;
    const card = (r, pos, pior) => `<button class="podio-item ${pior ? 'pior' : ''} p${pos}" data-a="rt-ieo-loja" data-id="${r.lojaId}">
        <span class="lugar">${pior ? `${r.posicao}º` : pos + 'º'}</span><b>${esc(r.codigo)} · ${esc(r.nome)}</b>
        <span class="pts">${Fmt.num(r.pontos, 0)}<small> pts</small></span><span class="pill ${IEO.ZONAS[r.zona].cls}">${IEO.ZONAS[r.zona].rotulo}</span>
        <span class="hint">${r.deducoes.length ? r.deducoes.length + ' dedução(ões)' : 'sem deduções'}</span></button>`;
    const top3 = ranking.slice(0, 3), bot3 = ranking.slice(-3).reverse();
    const podio = `<div class="grid g2 cs-top">
      <div class="panel"><h2>Top 3 · melhores lojas</h2><p class="sub">Maior pontuação no ciclo; empate decidido pelo menor número de ocorrências.</p>
        <div class="podio">${[top3[1], top3[0], top3[2]].map((r, i) => r ? card(r, [2, 1, 3][i], false) : '').join('')}</div></div>
      <div class="panel"><h2>3 piores lojas</h2><p class="sub">Menor pontuação no ciclo — prioridade da supervisão.</p>
        <div class="podio lista">${bot3.map((r, i) => card(r, i + 1, true)).join('')}</div></div></div>`;
    const lista = ranking.filter(r => !u.zona || r.zona === u.zona), mostrar = u.verTodas ? lista : lista.slice(0, 25);
    const tabela = `<div class="panel"><div class="row between"><div><h2>Ranking completo</h2><p class="sub">${fechado ? `Ciclo fechado em ${Fmt.dataHora(fechado.fechadoEm)} — pontuação congelada.` : 'Pontuação ao vivo: recalculada a cada falta, conciliação ou ocorrência lançada.'}</p></div>
        ${g('retaguarda.ieo.laudo') ? '<button class="btn ghost" data-a="rt-ieo-laudos-lote">Gerar laudos (zonas amarela e vermelha)</button>' : ''}</div>
      <div class="tbl-wrap"><table><thead><tr><th>Posição</th><th>Loja</th><th>Pontuação</th><th>Zona</th><th>Deduções</th><th>Mês anterior</th><th></th></tr></thead><tbody>
      ${mostrar.map(r => { const ap = antPos[r.lojaId], dv = ap ? ap - r.posicao : 0;
        return `<tr class="click" data-a="rt-ieo-loja" data-id="${r.lojaId}"><td class="mono"><b>${r.posicao}º</b></td><td><div class="cell-main">${esc(r.codigo)} · ${esc(r.nome)}</div><div class="cell-sub">${esc(Repo.get('lojas', r.lojaId)?.supervisor || '')}</div></td>
          <td><div class="meter ${IEO.ZONAS[r.zona].cls}"><i style="width:${r.pontos}%"></i></div><span class="mono"><b>${Fmt.num(r.pontos, 0)}</b></span></td>
          <td><span class="pill ${IEO.ZONAS[r.zona].cls}">${IEO.ZONAS[r.zona].rotulo}</span></td>
          <td>${Object.values(r.resumo).map(x => `<span class="pill neutral" style="margin:1px" title="${esc(x.nome)}">${esc(x.nome.split(' (')[0])} ×${x.n} (${x.pontos})</span>`).join('') || '<span class="hint">—</span>'}</td>
          <td>${ap ? `<span class="delta ${dv > 0 ? 'up' : dv < 0 ? 'down' : ''}">${dv > 0 ? '▲ ' + dv : dv < 0 ? '▼ ' + -dv : '='}</span> <span class="hint">${ap}º</span>` : '<span class="hint">—</span>'}</td>
          <td class="acts">${Repo.get('ieo_laudos', u.mes + '_' + r.lojaId) ? '<span class="pill info">laudo</span>' : ''}${r.zona === 'vermelha' ? this.botaoWhats(r, 'sm') : ''}</td></tr>`; }).join('')}
      </tbody></table></div>${lista.length > 25 ? `<button class="btn ghost sm" style="margin-top:8px" data-a="rt-ieo-todas">${u.verTodas ? 'Mostrar 25' : `Ver todas (${lista.length})`}</button>` : ''}</div>`;
    return topo + banner + kpis + podio + tabela;
  },

  /** Detalhe da loja: extrato de deduções + laudo. */
  abrirLojaIEO(lojaId) {
    const { mes, ranking } = this._ieoDados, r = ranking.find(x => x.lojaId === lojaId); if (!r) return;
    const laudo = Repo.get('ieo_laudos', mes + '_' + lojaId), z = IEO.ZONAS[r.zona], pode = Auth.can('retaguarda.ieo.laudo');
    const ocorr = Repo.get('ieo_ocorrencias', mes + '_' + lojaId);
    UI.modal({
      titulo: `IEO · ${r.codigo} · ${r.nome} · ${this.mesLabel(mes)}`, largo: true,
      corpo: `<div class="row" style="gap:18px;align-items:center;margin-bottom:12px"><div class="score-big">${Fmt.num(r.pontos, 0)}</div><div><span class="pill ${z.cls}">${z.rotulo} — ${z.desc}</span><div class="hint" style="margin-top:4px">${r.posicao}º de ${ranking.length} lojas · início com ${IEO.matriz().pontosIniciais} pontos</div></div>${r.zona === 'vermelha' ? `<div style="margin-left:auto">${this.botaoWhats(r)}</div>` : ''}</div>
        ${r.deducoes.length ? `<div class="tbl-wrap"><table><thead><tr><th>Data</th><th>Ocorrência</th><th>Detalhe</th><th class="num">Pontos</th>${Auth.can('retaguarda.ieo.lancar') ? '<th></th>' : ''}</tr></thead><tbody>
          ${r.deducoes.map(d => `<tr><td class="mono">${Fmt.data(d.data)}</td><td>${esc(d.nome)}<div class="cell-sub">${esc(IEO_ORIGENS[d.origem] || '')}</div></td><td>${esc(d.detalhe || '—')}</td><td class="num"><b style="color:var(--bad)">${d.pontos}</b></td>
            ${Auth.can('retaguarda.ieo.lancar') ? `<td class="acts">${d.origem === 'manual' && ocorr?.itens?.some(i => i.id === d.ref) ? `<button class="iconbtn" data-oc-del="${esc(d.ref)}" aria-label="Excluir ocorrência">${ICON.lixo}</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nenhuma dedução neste ciclo.</div>'}
        <div class="ai-box" style="margin-top:16px"><div class="row between"><h4>${ICON.ia} Laudo de Performance</h4>${laudo ? `<span class="hint">${laudo.origem === 'ia' ? 'redigido por IA' : 'automático'} · ${Fmt.dataHora(laudo.geradoEm)}</span>` : ''}</div>
          <div id="laudoTexto" style="white-space:pre-wrap;margin-top:8px">${laudo ? esc(laudo.texto) : '<span class="hint">Ainda não gerado.</span>'}</div></div>`,
      aoAbrir: mm => mm.addEventListener('click', async e => {
        const b = e.target.closest('[data-oc-del]'); if (!b) return;
        await Repo.salvar('ieo_ocorrencias', ocorr.id, { ...ocorr, itens: ocorr.itens.filter(i => i.id !== b.dataset.ocDel) }, { modulo: 'retaguarda', rotulo: `IEO · ocorrência · ${this.nomeLoja(lojaId)}`, detalhe: 'Ocorrência excluída' });
        UI.toast('Ocorrência excluída'); mm.closest('.overlay').remove(); document.body.classList.remove('modal-aberto');
      }),
      acoes: [{ rotulo: 'Fechar', classe: 'sec' },
        ...(pode ? [{ rotulo: 'Laudo automático', classe: 'sec', fechar: false, acao: async m => { await this.gerarLaudo(r, false); $('#laudoTexto', m).textContent = Repo.get('ieo_laudos', mes + '_' + lojaId).texto; } },
                    { rotulo: 'Gerar laudo com IA', fechar: false, acao: async m => { $('#laudoTexto', m).textContent = 'Redigindo o laudo…'; try { await this.gerarLaudo(r, true); $('#laudoTexto', m).textContent = Repo.get('ieo_laudos', mes + '_' + lojaId).texto; } catch (err) { $('#laudoTexto', m).textContent = err.message; } } }] : []),
        { rotulo: 'Imprimir laudo', classe: 'sec', fechar: false, acao: () => this.imprimirLaudo(r) }],
    });
  },
  dadosLaudo(r) {
    const { mes, ranking } = this._ieoDados;
    return Laudo.dados(r, { ranking, anterior: this.rankingIEO(this.mesAnterior(mes)).ranking, mes, loja: Repo.get('lojas', r.lojaId) });
  },
  async gerarLaudo(r, ia) {
    const { mes } = this._ieoDados, dados = this.dadosLaudo(r);
    // sem movimento no mês anterior, a posição anterior não é informada (evita "caiu" artificial)
    const semHistorico = !this.rankingIEO(this.mesAnterior(mes)).ranking.some(x => x.deducoes?.length);
    if (semHistorico) { dados.posicaoAnterior = null; dados.pontosAnteriores = null; }
    const texto = ia ? await Laudo.gerarIA(dados) : Laudo.local(dados);
    if (!texto) throw new Error('A IA não devolveu texto.');
    await Repo.salvar('ieo_laudos', mes + '_' + r.lojaId, { mes, lojaId: r.lojaId, texto, origem: ia ? 'ia' : 'automatico', dados, pontos: r.pontos, zona: r.zona, geradoEm: new Date().toISOString(), geradoPor: Auth.id },
      { modulo: 'retaguarda', rotulo: `Laudo IEO · ${r.codigo} · ${r.nome}`, detalhe: ia ? 'Gerado por IA' : 'Gerado automaticamente' });
  },
  async laudosEmLote() {
    const { ranking, mes } = this._ieoDados, alvo = ranking.filter(r => r.zona !== 'verde');
    if (!alvo.length) return UI.toast('Nenhuma loja nas zonas amarela ou vermelha.');
    const ia = !!Cloud.caps.sample;
    if (!(await UI.confirmar('Gerar laudos', `Gerar ${alvo.length} laudo(s) de ${this.mesLabel(mes)} ${ia ? 'com IA (uma chamada por loja, contabilizada na sua conta)' : 'automáticos (IA indisponível neste acesso)'}?`, 'Gerar'))) return;
    let n = 0;
    for (const r of alvo) { try { await this.gerarLaudo(r, ia); n++; UI.toast(`Laudos: ${n}/${alvo.length}`); } catch (e) { UI.toast(`Parado em ${r.nome}: ${e.message}`); break; } await sleep(300); }
  },
  imprimirLaudo(r) {
    const { mes, ranking } = this._ieoDados, laudo = Repo.get('ieo_laudos', mes + '_' + r.lojaId), z = IEO.ZONAS[r.zona];
    const texto = laudo ? laudo.texto : Laudo.local(this.dadosLaudo(r));
    const corpo = `${Documento.cabecalho('Laudo de Performance · IEO', `${r.codigo} · ${r.nome} · ${this.mesLabel(mes)}`)}
      <div style="display:flex;gap:28px;align-items:center;margin-bottom:10px"><div><div class="big">${Fmt.num(r.pontos, 0)}</div><div style="font-size:11px;color:#585E7F">pontos de ${IEO.matriz().pontosIniciais}</div></div>
        <div><span class="pill">${z.rotulo} — ${z.desc}</span><div style="font-size:11px;color:#585E7F;margin-top:4px">${r.posicao}º lugar entre ${ranking.length} lojas</div></div></div>
      <h2>Parecer</h2>${texto.split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join('')}
      <h2>Deduções do ciclo</h2>${r.deducoes.length ? `<table><thead><tr><th>Data</th><th>Ocorrência</th><th>Detalhe</th><th>Pontos</th></tr></thead><tbody>${r.deducoes.map(d => `<tr><td>${Fmt.data(d.data)}</td><td>${esc(d.nome)}</td><td>${esc(d.detalhe || '')}</td><td>${d.pontos}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhuma dedução.</p>'}
      <div class="sign"><div>Supervisor(a): ${esc(Repo.get('lojas', r.lojaId)?.supervisor || '')}</div><div>Gerente da loja</div></div>
      <div class="foot">${laudo?.origem === 'ia' ? 'Parecer redigido com apoio de IA a partir dos dados do IEO. ' : ''}Esposende · Painel de Gestão</div>`;
    Documento.previa('Laudo IEO · ' + r.nome, Documento.montar('Laudo IEO ' + r.codigo, corpo), `Laudo_IEO_${r.codigo}_${mes}`);
  },

  /** Matriz dinâmica de deduções (CRUD — GESTOR). */
  abrirMatriz() {
    const m = clone(IEO.matriz());
    const linha = (t, i) => `<tr data-i="${i}"><td><input name="nome" value="${esc(t.nome)}" aria-label="Nome da ocorrência"></td>
      <td><input name="pontos" type="number" step="0.5" max="0" value="${t.pontos}" aria-label="Pontos" style="max-width:90px"></td>
      <td><select name="origem" aria-label="Origem">${Object.entries(IEO_ORIGENS).map(([k, r]) => `<option value="${k}" ${k === t.origem ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></td>
      <td><label class="check"><input type="checkbox" name="ativo" ${t.ativo !== false ? 'checked' : ''}> ativo</label></td>
      <td>${t.id && IEO_PADRAO.tipos.some(p => p.id === t.id) ? '' : `<button class="iconbtn" type="button" data-rm="${i}" aria-label="Remover">${ICON.lixo}</button>`}</td></tr>`;
    const tabela = () => `<div class="tbl-wrap"><table class="nolabel matriz"><thead><tr><th>Ocorrência</th><th>Pontos</th><th>Como é apurada</th><th></th><th></th></tr></thead><tbody>${m.tipos.map(linha).join('')}</tbody></table></div>`;
    UI.modal({
      titulo: 'Matriz de deduções do IEO', largo: true,
      corpo: `<p class="hint" style="margin-top:0">Toda loja inicia o ciclo mensal com ${m.pontosIniciais} pontos. Tipos automáticos são apurados a partir das faltas e da conciliação Credsystem; os manuais são lançados em “+ Ocorrência”. Ciclos já fechados não mudam.</p>
        <div id="mtz">${tabela()}</div><button type="button" class="btn ghost sm" id="mtzAdd" style="margin-top:8px">+ Novo tipo de ocorrência</button>
        <div class="form-grid" style="margin-top:16px">
          ${campo('Pontos iniciais', 'pontosIniciais', m.pontosIniciais, { tipo: 'number' })}${campo('Limite Zona Verde (a partir de)', 'faixas.verde', m.faixas.verde, { tipo: 'number' })}
          ${campo('Limite Zona Vermelha (abaixo de)', 'faixas.vermelha', m.faixas.vermelha, { tipo: 'number' })}${campo('Reincidência a partir da falta nº', 'reincidenciaMinima', m.reincidenciaMinima, { tipo: 'number' })}
          ${campo('Prazo para justificar falta (dias)', 'prazoJustificativaDias', m.prazoJustificativaDias, { tipo: 'number' })}</div>`,
      aoAbrir: mm => {
        const ler = () => { $$('#mtz tbody tr', mm).forEach(tr => { const t = m.tipos[+tr.dataset.i]; t.nome = $('[name="nome"]', tr).value.trim(); t.pontos = Number($('[name="pontos"]', tr).value); t.origem = $('[name="origem"]', tr).value; t.ativo = $('[name="ativo"]', tr).checked; }); };
        $('#mtzAdd', mm).addEventListener('click', () => { ler(); m.tipos.push({ id: 'oc-' + uid(), nome: 'Nova ocorrência', pontos: -5, origem: 'manual', ativo: true }); $('#mtz', mm).innerHTML = tabela(); });
        mm.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (!b) return; ler(); m.tipos.splice(+b.dataset.rm, 1); $('#mtz', mm).innerHTML = tabela(); });
        mm._ler = ler;
      },
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Restaurar carga inicial', classe: 'ghost', fechar: false, acao: async mm => { if (!(await UI.confirmar('Restaurar matriz', 'Voltar aos cinco tipos e pesos iniciais?', 'Restaurar'))) return false; await Repo.salvar('config', 'ieo', clone(IEO_PADRAO), { modulo: 'retaguarda', rotulo: 'Matriz IEO', detalhe: 'Carga inicial restaurada' }); mm.closest('.overlay').remove(); document.body.classList.remove('modal-aberto'); } },
        { rotulo: 'Salvar matriz', acao: async mm => {
          mm._ler(); const d = UI.lerForm($('.form-grid', mm));
          if (m.tipos.some(t => !t.nome || isNaN(t.pontos) || t.pontos > 0)) { UI.toast('Cada ocorrência precisa de nome e pontos negativos (ou zero).'); return false; }
          if (!(d.faixas.vermelha < d.faixas.verde)) { UI.toast('O limite vermelho deve ser menor que o verde.'); return false; }
          await Repo.salvar('config', 'ieo', { ...m, ...d, faixas: d.faixas }, { modulo: 'retaguarda', rotulo: 'Matriz IEO' }); UI.toast('Matriz salva — pontuação recalculada.');
        } }],
    });
  },
  abrirOcorrencia(pre = {}) {
    const m = IEO.matriz(), mes = this.ui.ieo.mes || this.mesAtual();
    const lojas = Repo.todos('lojas').filter(l => l.ativa).sort((a, b) => a.codigo.localeCompare(b.codigo));
    const hoje = Datas.hojeISO(), dataPadrao = hoje.startsWith(mes) ? hoje : mes + '-01';
    UI.modal({
      titulo: 'Lançar ocorrência no IEO',
      corpo: `<div class="form-grid">${campo('Loja', 'lojaId', pre.lojaId || '', { opcoes: [['', 'Selecione…'], ...lojas.map(l => [l.id, `${l.codigo} · ${l.nome}`])] })}${campo('Data', 'data', dataPadrao, { tipo: 'date' })}
        ${campo('Ocorrência', 'tipoId', m.tipos.find(t => t.origem === 'manual')?.id || '', { opcoes: m.tipos.filter(t => t.ativo !== false).map(t => [t.id, `${t.nome} (${t.pontos})${t.origem !== 'manual' ? ' · normalmente automática' : ''}`]), full: true })}
        ${campo('Descrição', 'descricao', '', { tipo: 'textarea', full: true, attrs: 'placeholder="Ex.: PIX de R$ 189,90 baixado em duplicidade no dia 12"' })}</div>`,
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: 'Lançar', acao: async mm => {
        const d = UI.lerForm(mm); if (!d.lojaId || !d.data || !d.tipoId) { UI.toast('Informe loja, data e ocorrência.'); return false; }
        const id = d.data.slice(0, 7) + '_' + d.lojaId, doc = Repo.get('ieo_ocorrencias', id) || { mes: d.data.slice(0, 7), lojaId: d.lojaId, itens: [] };
        const t = m.tipos.find(x => x.id === d.tipoId);
        await Repo.salvar('ieo_ocorrencias', id, { ...doc, itens: [...doc.itens, { id: 'oc-' + uid(), data: d.data, tipoId: d.tipoId, descricao: d.descricao, lancadoPor: Auth.id, lancadoEm: new Date().toISOString() }] },
          { modulo: 'retaguarda', rotulo: `IEO · ${this.nomeLoja(d.lojaId)}`, detalhe: `${t?.nome} (${t?.pontos})` });
        UI.toast('Ocorrência lançada');
      } }],
    });
  },
  async fecharCiclo() {
    const { ranking, mes } = this._ieoDados;
    if (!(await UI.confirmar('Fechar ciclo', `Congelar a pontuação de ${this.mesLabel(mes)} para ${ranking.length} lojas? Depois do fechamento, novas faltas ou mudanças na matriz não alteram este mês (é possível reabrir).`, 'Fechar ciclo'))) return;
    await Repo.salvar('ieo_fechamentos', mes, { mes, matriz: IEO.matriz(), ranking: ranking.map(r => ({ lojaId: r.lojaId, codigo: r.codigo, nome: r.nome, pontos: r.pontos, zona: r.zona, posicao: r.posicao, resumo: r.resumo, deducoes: r.deducoes })), fechadoEm: new Date().toISOString(), fechadoPor: Auth.id },
      { modulo: 'retaguarda', rotulo: 'Fechamento IEO ' + this.mesLabel(mes) });
    UI.toast('Ciclo fechado');
  },
  /** Linha do ranking para o alerta (com o resumo de deduções do mês do alerta). */
  linhaIEODoAlerta(a) {
    const d = this._ieoDados; let r = d && d.mes === a.mes ? d.ranking.find(x => x.lojaId === a.lojaId) : null;
    if (!r) { try { r = this.rankingIEO(a.mes).ranking.find(x => x.lojaId === a.lojaId); } catch { r = null; } }
    const l = Repo.get('lojas', a.lojaId) || {};
    return r ? { ...r, mesAlerta: a.mes } : { lojaId: a.lojaId, codigo: l.codigo || '', nome: l.nome || a.lojaId, pontos: a.pontos, resumo: {}, mesAlerta: a.mes };
  },
  abrirAlertas() {
    const lista = this.alertasAbertos().sort((a, b) => a.pontos - b.pontos);
    UI.modal({
      titulo: 'Alertas para a supervisão', largo: true,
      corpo: lista.length ? lista.map(a => `<div class="panel" style="margin-bottom:10px;padding:14px"><div class="row between"><b>${esc(this.nomeLoja(a.lojaId))}</b><span class="pill bad">${Fmt.num(a.pontos, 0)} pts · ${this.mesLabel(a.mes)}</span></div>
          <p class="hint" style="margin:4px 0 10px">Supervisor: ${esc(a.supervisor || '—')} · alerta criado em ${Fmt.dataHora(a.criadoEm)}</p>
          <div class="row">${this.botaoWhats(this.linhaIEODoAlerta(a), 'sm')}<button class="btn sec sm" data-copiar="${a.id}">Copiar aviso</button>${Auth.can('retaguarda.ieo.lancar') ? `<button class="btn sm" data-ciente="${a.id}">Marcar ciência</button>` : ''}</div></div>`).join('')
        : '<div class="empty">Nenhum alerta pendente.</div>',
      aoAbrir: mm => mm.addEventListener('click', async e => {
        const cp = e.target.closest('[data-copiar]'), ci = e.target.closest('[data-ciente]');
        if (cp) { const a = Repo.get('alertas', cp.dataset.copiar); try { await navigator.clipboard.writeText(this.textoAviso(a)); UI.toast('Aviso copiado — cole no WhatsApp ou e-mail do supervisor.'); } catch { UI.toast('Não foi possível copiar automaticamente.'); } }
        if (ci) { const a = Repo.get('alertas', ci.dataset.ciente); await Repo.salvar('alertas', a.id, { ...a, cienteEm: new Date().toISOString(), cientePor: Auth.id }, { modulo: 'retaguarda', rotulo: `Alerta IEO · ${this.nomeLoja(a.lojaId)}`, detalhe: 'Ciência registrada' }); ci.closest('.panel').remove(); }
      }),
      acoes: [{ rotulo: 'Fechar', classe: 'sec' }],
    });
  },

  bloqueado(titulo, texto) {
    return `<div class="panel standby"><div class="row" style="gap:14px;align-items:flex-start"><div class="ico-lock">${ICON.cadeado}</div><div><h2>${esc(titulo)} · acesso restrito</h2><p class="sub" style="margin:0">${esc(texto)}</p></div></div></div>`;
  },

  /* =====================================================================
     ALERTA DE ZONA VERMELHA VIA WHATSAPP (IEO)
     ===================================================================== */
  /** Mensagem padrão. "Fator crítico" = tipo de dedução que mais tirou pontos. */
  mensagemWhatsIEO(r, mes = this.ui.ieo.mes) {
    const pior = Object.entries(r.resumo || {}).sort((a, b) => a[1].pontos - b[1].pontos)[0];
    const fator = pior ? `${pior[1].n} ${(IEO_ROTULO_CURTO[pior[0]] || [pior[1].nome, pior[1].nome])[pior[1].n > 1 ? 1 : 0]} (${String(pior[1].pontos).replace('.', ',')} pontos)` : 'sem deduções registradas';
    const ciclo = mes === this.mesAtual() ? 'no ciclo atual' : `no ciclo de ${this.mesLabel(mes)}`;
    return `⚠️ Alerta de Retaguarda: A filial ${r.codigo} · ${r.nome} atingiu ${String(r.pontos).replace('.', ',')} pontos (Zona Vermelha) ${ciclo}. Fator crítico principal: ${fator}. Acesse o Painel de Gestão para mais detalhes.`;
  },
  botaoWhats(r, classe = '') {
    return `<a class="btn wa ${classe}" href="${esc(WhatsApp.link(this.mensagemWhatsIEO(r, r.mesAlerta || this.ui.ieo.mes)))}" target="_blank" rel="noopener" data-a="rt-wa" data-id="${r.lojaId}">${ICON.whats} Notificar Supervisão via WhatsApp</a>`;
  },

  /* ======================= eventos das abas novas ======================= */
  async acaoFin(a, el) {
    const ie = this.ui.ieo;
    switch (a) {
      case 'rt-ieo-matriz': return this.abrirMatriz();
      case 'rt-ieo-ocorrencia': return this.abrirOcorrencia();
      case 'rt-ieo-fechar': return this.fecharCiclo();
      case 'rt-ieo-reabrir': if (await UI.confirmar('Reabrir ciclo', `Reabrir ${this.mesLabel(ie.mes)}? A pontuação volta a ser calculada ao vivo.`, 'Reabrir')) await Repo.excluir('ieo_fechamentos', ie.mes, { modulo: 'retaguarda', rotulo: 'Fechamento IEO ' + this.mesLabel(ie.mes) }); return;
      case 'rt-ieo-loja': return this.abrirLojaIEO(el.dataset.id);
      case 'rt-ieo-todas': ie.verTodas = !ie.verTodas; return App.render();
      case 'rt-ieo-alertas': return this.abrirAlertas();
      case 'rt-ieo-laudos-lote': return this.laudosEmLote();
      case 'rt-wa': { // o link abre o WhatsApp; aqui só registramos no log
        const r = (this._ieoDados?.ranking || []).find(x => x.lojaId === el.dataset.id);
        if (r) Audit.registrar({ modulo: 'retaguarda', acao: 'notificou', entidade: 'alertas', entidadeId: this.ui.ieo.mes + '_' + r.lojaId, rotulo: `WhatsApp · ${r.codigo} · ${r.nome}`, detalhe: `Zona Vermelha com ${r.pontos} pontos`, mudancas: [] });
        return;
      }
    }
  },
  async mudancaFin(a, el) {
    if (a === 'rt-ieo') { this.ui.ieo[el.dataset.k] = el.value; return App.render(); }
  },
  entradaFin() { },
});
