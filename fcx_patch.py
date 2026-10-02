"""Ajustes de desempenho e integração aplicados ao FCX original no build (o arquivo-fonte não é alterado).

1. Lançamentos de saídas: a tabela deixa de montar até 500 linhas numa string a cada render e
   passa a ser paginada (100 por página). As linhas da página são montadas num DocumentFragment
   e inseridas de uma vez; trocar de página não re-renderiza a tela inteira.
   (Antes, além de lento, o filtro escondia em silêncio o que passava de 500 linhas.)
2. window.FCXAPI: expõe ao Painel (aba DFC e Motor de Aluguel do Módulo 2) o motor de projeção já
   existente — buildCashBook, saídas, rótulos, meta comercial do mês — e uma porta de escrita
   (sincronizarSaidas) para as provisões de aluguel calculadas no Módulo 2.
3. Aviso ao Painel quando os dados terminam de carregar (FCX._pronto).
4. Texto de ajuda do backup sem menção ao ambiente de criação.
Layout, classes e telas do FCX permanecem os mesmos.
"""
import sys

def patch(html: str) -> str:
    def rep(a, b, n=1):
        nonlocal html
        c = html.count(a)
        if c != n:
            sys.exit(f'fcx_patch: trecho encontrado {c}x (esperado {n}): {a[:90]!r}')
        html = html.replace(a, b)

    # 0) texto de ajuda sem referência ao ambiente em que a ferramenta foi criada (só texto)
    rep("sempre que eu (Claude) for te enviar uma versão nova da ferramenta.", "sempre que uma versão nova da ferramenta for instalada.")

    # 1) linhas das saídas → função de linha + paginação com DocumentFragment
    rep("  const rowsHtml = list.slice(0,500).map(s=>`\n    <tr><td>${fmtDate(s.date)}",
        "  state._saidasLista = list;\n  const rowsHtml = '';\n  window.__saidaRow = s=>`\n    <tr><td>${fmtDate(s.date)}")
    rep("""<td><button class="btn danger" onclick="removeSaida('${s.id}')">Remover</button></td></tr>`).join('');""",
        """<td><button class="btn danger" onclick="removeSaida('${s.id}')">Remover</button></td></tr>`;""")
    rep("""<tbody>${rowsHtml}</tbody></table></div>${list.length>500?'<div class="hint">Mostrando os primeiros 500 lançamentos do filtro atual.</div>':''}""",
        """<tbody id="saidasBody">${rowsHtml}</tbody></table></div><div id="saidasPager"></div>""")
    rep("/* ---------- CONTAS & CENTROS DE CUSTO ---------- */", r"""/* ---------- paginação dos lançamentos (DocumentFragment) ---------- */
const SAIDAS_POR_PAGINA = 100;
function renderSaidasPagina(){
  const tb = document.getElementById('saidasBody'); if(!tb) return;
  const list = state._saidasLista || [];
  const sig = JSON.stringify(state._saidaFilter);
  if(state._saidasSig !== sig){ state._saidasSig = sig; state._saidasPag = 1; }
  const pags = Math.max(1, Math.ceil(list.length / SAIDAS_POR_PAGINA));
  state._saidasPag = Math.min(Math.max(1, state._saidasPag || 1), pags);
  const ini = (state._saidasPag - 1) * SAIDAS_POR_PAGINA, fatia = list.slice(ini, ini + SAIDAS_POR_PAGINA);
  const tpl = document.createElement('template');
  tpl.innerHTML = fatia.map(window.__saidaRow).join('');
  const frag = document.createDocumentFragment(); frag.appendChild(tpl.content);
  tb.replaceChildren(frag);
  const pg = document.getElementById('saidasPager');
  if(pg) pg.innerHTML = list.length > SAIDAS_POR_PAGINA ? `<div class="row-flex" style="margin-top:10px;justify-content:space-between;align-items:center;">
      <span class="hint">Linhas ${ini+1}–${ini+fatia.length} de ${list.length.toLocaleString('pt-BR')}</span>
      <div class="row-flex" style="gap:6px;align-items:center;"><button class="btn secondary small" ${state._saidasPag<=1?'disabled':''} onclick="paginaSaidas(-1)">‹ Anterior</button>
      <span class="hint">Página ${state._saidasPag} de ${pags}</span>
      <button class="btn secondary small" ${state._saidasPag>=pags?'disabled':''} onclick="paginaSaidas(1)">Próxima ›</button></div></div>` : '';
}
function paginaSaidas(d){
  state._saidasPag = (state._saidasPag || 1) + d; renderSaidasPagina();
  const p = document.getElementById('saidasBody'); if(p) p.closest('.panel').scrollIntoView({block:'start'});
}
window.paginaSaidas = paginaSaidas;

/* ---------- CONTAS & CENTROS DE CUSTO ---------- */""")
    rep("function afterRender(){\n  if(state.screen==='view') drawChart();",
        "function afterRender(){\n  if(state.screen==='manage' && state.tab==='saidas') renderSaidasPagina();\n  if(state.screen==='view') drawChart();")

    # 2) API para o Painel + 3) aviso de carga concluída
    rep("""(async function init(){
  render();
  await loadAll();
  render();
})();""", """window.FCXAPI = {
  pronto: () => state.loaded,
  livro: (ini, fim) => buildCashBook(ini, fim, '', '', 'conta', true),
  saidas: () => state.saidas,
  metodos: METHOD_LABELS,
  contaRepasse: CONTA_REPASSE,
  /* Módulo 2 · Motor de Aluguel */
  vendasPrevistas: mk => Number((state.monthMeta[mk] || {}).metaComercial) || 0,   // meta comercial (vendas brutas) do mês
  contas: () => state.config.accounts.slice(),
  centros: () => state.config.costCenters.slice(),
  /** Grava/atualiza/remove linhas de saída vindas do Painel (ids fixos) e salva; devolve quantas mudaram. */
  sincronizarSaidas(upserts, remover){
    let n = 0;
    (remover || []).forEach(id => { const i = state.saidas.findIndex(s => s.id === id); if(i >= 0){ state.saidas.splice(i, 1); n++; } });
    (upserts || []).forEach(s => {
      if(s.conta && !state.config.accounts.includes(s.conta)) state.config.accounts.push(s.conta);
      if(s.centro && !state.config.costCenters.includes(s.centro)) state.config.costCenters.push(s.centro);
      const i = state.saidas.findIndex(x => x.id === s.id);
      if(i < 0){ state.saidas.push({...s}); n++; return; }
      const novo = {...state.saidas[i], ...s};
      if(JSON.stringify(novo) !== JSON.stringify(state.saidas[i])){ state.saidas[i] = novo; n++; }
    });
    if(n){ scheduleAutosave(); if(state.loaded) render(); }
    return n;
  },
};
(async function init(){
  render();
  await loadAll();
  render();
  try{ if(window.parent && window.parent.FCX && window.parent.FCX._pronto) window.parent.FCX._pronto(); }catch(e){}
})();""")
    return html

if __name__ == '__main__':
    src, dst = sys.argv[1], sys.argv[2]
    open(dst, 'w', encoding='utf-8').write(patch(open(src, encoding='utf-8').read()))
