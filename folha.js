/* =====================================================================
   FOLHA — cálculo de encargos, folha líquida estimada e custo real
   ---------------------------------------------------------------------
   AJUSTE AQUI conforme o regime tributário da Esposende.
   • Tabelas do empregado (INSS e IRRF) mudam todo ano: atualize a
     vigência e os valores em janeiro.
   • Encargos patronais e provisões também podem ser alterados pela
     tela (Gestão de Pessoal → Parâmetros da folha), que grava em
     config/folha e sobrescreve os valores abaixo sem mexer no código.
   Todos os percentuais estão em fração (0.08 = 8%).
   ===================================================================== */
const FOLHA_PADRAO = {
  vigencia: '2026',
  regime: 'LUCRO_REAL', // 'LUCRO_REAL' (também vale p/ Presumido) | 'SIMPLES'

  /* ---- Descontos do empregado ---- */
  // INSS 2026 — tabela progressiva (salário mínimo R$ 1.621,00; teto R$ 8.475,55)
  inssEmpregado: {
    faixas: [
      { ate: 1621.00, aliquota: 0.075 },
      { ate: 2902.84, aliquota: 0.09 },
      { ate: 4354.27, aliquota: 0.12 },
      { ate: 8475.55, aliquota: 0.14 },
    ],
  },
  // IRRF mensal 2026 — tabela progressiva + redutor da Lei 15.270/2025
  irrf: {
    faixas: [
      { ate: 2428.80, aliquota: 0, deduzir: 0 },
      { ate: 2826.65, aliquota: 0.075, deduzir: 182.16 },
      { ate: 3751.05, aliquota: 0.15, deduzir: 394.16 },
      { ate: 4664.68, aliquota: 0.225, deduzir: 675.49 },
      { ate: Infinity, aliquota: 0.275, deduzir: 908.73 },
    ],
    deducaoDependente: 189.59,
    descontoSimplificado: 607.20,        // usado quando for maior que INSS + dependentes
    redutor: { limiteIsencao: 5000.00, valorAteLimite: 312.89, limiteFinal: 7350.00, constante: 978.62, fator: 0.133145 },
  },
  valeTransporte: { descontar: false, percentual: 0.06 }, // desconto de até 6% do salário

  /* ---- Encargos patronais (sobre o salário) ---- */
  patronal: {
    inss: 0.20,          // cota patronal (0 no Simples Nacional, Anexos I a III)
    rat: 0.02,           // RAT/SAT conforme CNAE — confirme no eSocial
    fap: 1.00,           // Fator Acidentário de Prevenção (0,5 a 2,0)
    terceiros: 0.058,    // FPAS 515 (comércio): Sal.-educação 2,5 + INCRA 0,2 + SESC 1,5 + SENAC 1,0 + SEBRAE 0,6
    fgts: 0.08,
  },

  /* ---- Provisões mensais ---- */
  provisoes: {
    ferias: (1 / 12) * (4 / 3),  // 1/12 de férias + 1/3 constitucional = 11,11%
    decimoTerceiro: 1 / 12,      // 8,33%
    encargosSobreProvisoes: true, // INSS patronal, RAT, terceiros e FGTS incidem sobre férias e 13º
    multaFgtsRescisoria: false,   // provisão de 40% do FGTS (opcional)
  },

  beneficiosPorColaborador: 0, // R$/mês (VR, VA, plano de saúde…) somado ao custo real
};

/** Predefinições de regime: aplicadas pela tela de parâmetros. */
const FOLHA_REGIMES = {
  LUCRO_REAL: { rotulo: 'Lucro Real / Presumido', patronal: { inss: 0.20, rat: 0.02, fap: 1, terceiros: 0.058, fgts: 0.08 } },
  SIMPLES: { rotulo: 'Simples Nacional (Anexo I — comércio)', patronal: { inss: 0, rat: 0, fap: 1, terceiros: 0, fgts: 0.08 } },
};

const Folha = {
  /** Parâmetros vigentes = padrão do código + ajustes salvos pelo GESTOR (config/folha). */
  params() {
    const salvo = Repo.get('config', 'folha');
    return salvo && salvo.params ? mergeProfundo(FOLHA_PADRAO, salvo.params) : FOLHA_PADRAO;
  },
  r2: n => Math.round((n + Number.EPSILON) * 100) / 100,

  /** INSS do empregado pela tabela progressiva (cada faixa tributa só a sua parte). */
  inssEmpregado(sal, p = this.params()) {
    let ant = 0, total = 0;
    for (const f of p.inssEmpregado.faixas) {
      if (sal <= ant) break;
      total += (Math.min(sal, f.ate) - ant) * f.aliquota; ant = f.ate;
    }
    return this.r2(total);
  },

  /** IRRF mensal com dedução legal ou desconto simplificado (o que for melhor) e redutor 2026. */
  irrf(sal, inss, dependentes = 0, p = this.params()) {
    const t = p.irrf, legais = inss + dependentes * t.deducaoDependente;
    const deducao = Math.max(legais, t.descontoSimplificado);
    const base = Math.max(0, sal - deducao);
    const faixa = t.faixas.find(f => base <= f.ate);
    const imposto = Math.max(0, base * faixa.aliquota - faixa.deduzir);
    let redutor = 0; const r = t.redutor;
    if (r) {
      if (sal <= r.limiteIsencao) redutor = r.valorAteLimite;
      else if (sal <= r.limiteFinal) redutor = Math.max(0, r.constante - r.fator * sal);
    }
    return { base: this.r2(base), deducao: this.r2(deducao), usouSimplificado: t.descontoSimplificado > legais, imposto: this.r2(imposto), redutor: this.r2(Math.min(redutor, imposto)), valor: this.r2(Math.max(0, imposto - redutor)) };
  },

  /**
   * Cálculo completo de um salário.
   * @returns {{base, inss, irrf, vt, liquido, encargos:[{rotulo,valor}], totalEncargos, custoTotal, fator}}
   */
  calcular(salario, { dependentes = 0 } = {}) {
    const p = this.params(), s = Number(salario) || 0;
    if (!s) return null;
    const inss = this.inssEmpregado(s, p);
    const ir = this.irrf(s, inss, Number(dependentes) || 0, p);
    const vt = p.valeTransporte.descontar ? this.r2(s * p.valeTransporte.percentual) : 0;
    const liquido = this.r2(s - inss - ir.valor - vt);

    const pt = p.patronal, pv = p.provisoes;
    const ratAjustado = pt.rat * pt.fap;
    const aliqSobreFolha = pt.inss + ratAjustado + pt.terceiros + pt.fgts;
    const provFerias = s * pv.ferias, prov13 = s * pv.decimoTerceiro;
    const encargos = [
      { rotulo: 'INSS patronal', valor: s * pt.inss, pct: pt.inss },
      { rotulo: 'RAT × FAP', valor: s * ratAjustado, pct: ratAjustado },
      { rotulo: 'Terceiros (Sistema S)', valor: s * pt.terceiros, pct: pt.terceiros },
      { rotulo: 'FGTS', valor: s * pt.fgts, pct: pt.fgts },
      { rotulo: 'Provisão de férias + 1/3', valor: provFerias, pct: pv.ferias },
      { rotulo: 'Provisão de 13º salário', valor: prov13, pct: pv.decimoTerceiro },
    ];
    if (pv.encargosSobreProvisoes) encargos.push({ rotulo: 'Encargos sobre provisões', valor: (provFerias + prov13) * aliqSobreFolha, pct: (pv.ferias + pv.decimoTerceiro) * aliqSobreFolha });
    if (pv.multaFgtsRescisoria) encargos.push({ rotulo: 'Provisão multa FGTS (40%)', valor: s * pt.fgts * 0.4, pct: pt.fgts * 0.4 });
    if (p.beneficiosPorColaborador) encargos.push({ rotulo: 'Benefícios', valor: Number(p.beneficiosPorColaborador), pct: Number(p.beneficiosPorColaborador) / s });
    encargos.forEach(e => { e.valor = this.r2(e.valor); });
    const totalEncargos = this.r2(encargos.reduce((a, e) => a + e.valor, 0));
    const custoTotal = this.r2(s + totalEncargos);
    return { base: s, inss, irrf: ir, vt, liquido, encargos, totalEncargos, custoTotal, fator: custoTotal / s, params: p };
  },

  /** Bloco HTML com a composição (usado no formulário do colaborador). */
  composicaoHTML(c) {
    if (!c) return '<p class="hint">Informe o salário para ver a folha líquida e o custo real.</p>';
    const pct = v => Fmt.pct(v * 100, 2);
    return `<div class="grid g3 folha-kpis">
        <div class="kpi"><div class="k">Salário base</div><div class="v mono">${Fmt.brl(c.base)}</div></div>
        <div class="kpi"><div class="k">Líquido estimado</div><div class="v mono" style="color:var(--ok)">${Fmt.brl(c.liquido)}</div><div class="d">${Fmt.pct((c.liquido / c.base) * 100, 1)} do salário</div></div>
        <div class="kpi"><div class="k">Custo real para a empresa</div><div class="v mono" style="color:var(--accent)">${Fmt.brl(c.custoTotal)}</div><div class="d">${Fmt.num(c.fator, 2)}× o salário</div></div>
      </div>
      <div class="grid g2" style="margin-top:12px">
        <div class="tbl-wrap"><table class="nolabel"><thead><tr><th>Descontos do colaborador</th><th class="num">Valor</th></tr></thead><tbody>
          <tr><td>INSS (tabela progressiva ${esc(c.params.vigencia)})</td><td class="num">− ${Fmt.brl(c.inss)}</td></tr>
          <tr><td>IRRF ${c.irrf.redutor ? `<span class="hint">(imposto ${Fmt.brl(c.irrf.imposto)} − redutor ${Fmt.brl(c.irrf.redutor)})</span>` : ''}${c.irrf.usouSimplificado ? ' <span class="hint">· desconto simplificado</span>' : ''}</td><td class="num">− ${Fmt.brl(c.irrf.valor)}</td></tr>
          ${c.vt ? `<tr><td>Vale-transporte</td><td class="num">− ${Fmt.brl(c.vt)}</td></tr>` : ''}
          <tr><td><b>Folha líquida estimada</b></td><td class="num"><b>${Fmt.brl(c.liquido)}</b></td></tr></tbody></table></div>
        <div class="tbl-wrap"><table class="nolabel"><thead><tr><th>Encargos e provisões da empresa</th><th class="num">%</th><th class="num">Valor</th></tr></thead><tbody>
          ${c.encargos.map(e => `<tr><td>${esc(e.rotulo)}</td><td class="num">${pct(e.pct)}</td><td class="num">${Fmt.brl(e.valor)}</td></tr>`).join('')}
          <tr><td><b>Total de encargos</b></td><td class="num">${pct(c.totalEncargos / c.base)}</td><td class="num"><b>${Fmt.brl(c.totalEncargos)}</b></td></tr></tbody></table></div>
      </div>
      <p class="hint" style="margin-top:8px">Estimativa mensal sem horas extras, comissões, faltas ou pensão. Parâmetros: ${esc(FOLHA_REGIMES[c.params.regime]?.rotulo || c.params.regime)}.</p>`;
  },

  /** Tela de parâmetros (GESTOR). Grava config/folha — o log registra quem alterou. */
  abrirParametros() {
    const p = this.params(), pt = p.patronal, pv = p.provisoes;
    const pc = v => Fmt.num(v * 100, 2).replace('.', '');
    const campoPct = (rot, nome, v, dica) => campo(rot + ' (%)', nome, pc(v), { attrs: 'inputmode="decimal" data-pct="1"', dica });
    UI.modal({
      titulo: 'Parâmetros da folha', largo: true,
      corpo: `<div class="note" style="margin-bottom:14px">Valores usados no cálculo de folha líquida e custo real de todos os colaboradores. As tabelas de INSS e IRRF ${esc(p.vigencia)} ficam no código (<span class="mono">FOLHA_PADRAO</span>) e devem ser atualizadas a cada ano.</div>
        <div class="form-grid">
          ${campo('Regime tributário', 'regime', p.regime, { opcoes: Object.entries(FOLHA_REGIMES).map(([k, r]) => [k, r.rotulo]), dica: 'Ao trocar, os encargos patronais abaixo recebem os valores padrão do regime.' })}
          ${campo('Benefícios por colaborador (R$/mês)', 'beneficiosPorColaborador', p.beneficiosPorColaborador, { tipo: 'number', dica: 'VR, VA, plano de saúde. Entra no custo real.' })}
          ${campoPct('INSS patronal', 'patronal.inss', pt.inss)}${campoPct('RAT/SAT', 'patronal.rat', pt.rat, 'Conforme CNAE.')}
          ${campo('FAP', 'patronal.fap', Fmt.num(pt.fap, 4), { attrs: 'inputmode="decimal" data-num="1"', dica: 'Entre 0,5000 e 2,0000.' })}${campoPct('Terceiros (Sistema S)', 'patronal.terceiros', pt.terceiros)}
          ${campoPct('FGTS', 'patronal.fgts', pt.fgts)}
          <div class="field"><span class="lbl">Provisões</span>
            <label class="check" style="padding-top:6px"><input type="checkbox" name="provisoes.encargosSobreProvisoes" ${pv.encargosSobreProvisoes ? 'checked' : ''}> Encargos sobre férias e 13º</label>
            <label class="check" style="padding-top:6px"><input type="checkbox" name="provisoes.multaFgtsRescisoria" ${pv.multaFgtsRescisoria ? 'checked' : ''}> Provisionar multa de 40% do FGTS</label>
            <label class="check" style="padding-top:6px"><input type="checkbox" name="valeTransporte.descontar" ${p.valeTransporte.descontar ? 'checked' : ''}> Descontar vale-transporte (6%) no líquido</label></div>
        </div>`,
      aoAbrir: m => $('[name="regime"]', m).addEventListener('change', e => {
        const r = FOLHA_REGIMES[e.target.value]; if (!r) return;
        Object.entries(r.patronal).forEach(([k, v]) => { const i = $(`[name="patronal.${k}"]`, m); if (i) i.value = k === 'fap' ? Fmt.num(v, 4) : pc(v); });
      }),
      acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, {
        rotulo: 'Salvar parâmetros', acao: async m => {
          const d = {};
          $$('[name]', m).forEach(i => {
            let v;
            if (i.type === 'checkbox') v = i.checked;
            else if (i.dataset.pct) v = Number(String(i.value).replace(/\./g, '').replace(',', '.')) / 100;
            else if (i.dataset.num || i.type === 'number') v = Number(String(i.value).replace(',', '.')) || 0;
            else v = i.value;
            setPath(d, i.name, v);
          });
          if (Object.values(d.patronal).some(v => isNaN(v) || v < 0)) { UI.toast('Confira os percentuais.'); return false; }
          await Repo.salvar('config', 'folha', { params: d }, { modulo: 'pessoal', rotulo: 'Parâmetros da folha' });
          UI.toast('Parâmetros salvos — custos recalculados.');
        }
      }],
    });
  },
};
