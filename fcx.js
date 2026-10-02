/* =====================================================================
   MÓDULO 3 — FCX (Fluxo de Caixa)
   Abas:
     • FCX · Fluxo de Caixa — o arquivo original "Fluxo de Caixa - Esposende" (layout e telas
       validados) roda isolado num iframe. Só recebe ajustes de desempenho no build.
     • DFC                  — extratos OFX, DFC e o cruzamento Realizado × Previsto (fcx-dfc.js).

   DESEMPENHO (v6)
     1. Leitura: todos os documentos fcx/* chegam numa única consulta (antes: ~26 leituras em
        sequência) e ficam em cache; o FCX lê do cache → abre na hora.
     2. Gravação: o FCX grava as 8 chaves a cada alteração. A ponte compara com o cache e só envia
        as fatias que mudaram, em paralelo (antes: ~34 gravações em sequência por alteração).
        Se outro usuário alterou a mesma chave, grava a chave inteira (sem misturar versões).
     3. O iframe é criado uma única vez e fica num contêiner próprio (#fcxHost), fora da área
        re-renderizada: trocar de aba ou de módulo não recarrega o FCX.
     4. Pré-carga: depois que o painel abre, o cache e o iframe são preparados em segundo plano.
   ===================================================================== */
const FCX = {
  html: null, carregando: null, _logAt: {}, versao: 0,
  ui: { aba: 'fcx' },
  PARTE: 80000, // caracteres por fatia (≤ 240 KB mesmo com acentos)
  chave: k => String(k).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_'),

  /* ---------- cache das chaves do FCX ---------- */
  _cache: null, _cacheProm: null,
  fatiar(v) { const out = []; for (let i = 0; i < Math.max(1, Math.ceil(v.length / this.PARTE)); i++) out.push(v.slice(i * this.PARTE, (i + 1) * this.PARTE)); return out; },
  async precarregar() {
    if (this._cache) return this._cache;
    return (this._cacheProm ||= (async () => {
      const cache = new Map();
      let docs = null;
      try { docs = await Cloud.adapter.list('fcx'); } catch { docs = null; }
      if (docs) {
        const porId = new Map(docs.map(d => [d.id, d]));
        const metas = docs.filter(d => d.chave && !String(d.id).includes('~'));
        await Promise.all(metas.map(async m => {
          const partes = [];
          for (let i = 0; i < (m.partes || 0); i++) {
            let p = porId.get(m.id + '~' + i);
            if (!p) p = await Cloud.adapter.get('fcx/' + m.id + '~' + i); // fatia fora da listagem: busca direta
            if (!p) throw new Error('Fatia ausente: ' + m.chave);
            partes.push(p.v);
          }
          cache.set(m.id, { chave: m.chave, meta: m, partes, valor: partes.join('') });
        }));
      }
      this._cache = cache; this._listado = !!docs;
      return cache;
    })().catch(e => { this._cacheProm = null; throw e; }));
  },
  async _lerDireto(k) {
    const meta = await Cloud.adapter.get('fcx/' + k); if (!meta) return null;
    const partes = await Promise.all(Array.from({ length: meta.partes || 0 }, (_, i) => Cloud.adapter.get('fcx/' + k + '~' + i).then(p => { if (!p) throw new Error('Fatia ausente: ' + k); return p.v; })));
    return { chave: meta.chave, meta, partes, valor: partes.join('') };
  },

  /* ---------- ponte window.storage (API usada pelo FCX) ---------- */
  storage: {
    async get(key) {
      const k = FCX.chave(key), cache = await FCX.precarregar();
      let c = cache.get(k);
      if (!c && !FCX._listado) { c = await FCX._lerDireto(k); if (c) cache.set(k, c); }
      return c ? { key, value: c.valor, shared: true } : null;
    },
    async set(key, value) {
      if (!Auth.can('fcx.editar')) { FCX.avisoLeitura(); throw new Error('FCX em modo somente leitura para o seu acesso.'); } // v14: matriz de acessos
      const k = FCX.chave(key), v = String(value), cache = await FCX.precarregar();
      const atual = cache.get(k);
      if (atual && atual.valor === v) return { key, value, shared: true };   // nada mudou: não grava
      // outro usuário gravou esta chave depois da nossa leitura? então grava a chave inteira
      let base = atual;
      if (atual) { const meta = await Cloud.adapter.get('fcx/' + k); if (!meta || meta.atualizadoEm !== atual.meta.atualizadoEm || meta.partes !== atual.meta.partes) base = null; }
      const partes = FCX.fatiar(v), n = partes.length;
      Sync.ocupado(true);
      try {
        await Promise.all(partes.map((p, i) => base && base.partes[i] === p ? null : Cloud.adapter.set('fcx/' + k + '~' + i, { v: p })));
        const meta = { chave: key, partes: n, tamanho: v.length, atualizadoEm: new Date().toISOString(), atualizadoPor: Auth.id };
        await Cloud.adapter.set('fcx/' + k, meta);
        const sobras = []; for (let i = n; i < (atual?.meta?.partes || 0); i++) sobras.push(Cloud.adapter.remove('fcx/' + k + '~' + i));
        await Promise.all(sobras);
        cache.set(k, { chave: key, meta, partes, valor: v });
      } finally { Sync.ocupado(false); }
      FCX.versao++; FCX.aoMudar();
      // auditoria (agrupa salvamentos automáticos da mesma chave a cada 60 s)
      const agora = Date.now();
      if (!FCX._logAt[key] || agora - FCX._logAt[key] > 60000) {
        FCX._logAt[key] = agora;
        Audit.registrar({ modulo: 'fcx', acao: atual ? 'alterou' : 'criou', entidade: 'fcx', entidadeId: key, rotulo: 'FCX · ' + key.replace('esp2:', ''), mudancas: [{ campo: 'tamanho', de: String(atual?.meta?.tamanho ?? '—'), para: String(v.length) }] });
      }
      return { key, value, shared: true };
    },
    async delete(key) {
      if (!Auth.can('fcx.excluir')) { FCX.avisoLeitura(); throw new Error('Exclusão no FCX não liberada para o seu acesso.'); } // v14: matriz de acessos
      const k = FCX.chave(key), cache = await FCX.precarregar(), meta = cache.get(k)?.meta || await Cloud.adapter.get('fcx/' + k);
      await Promise.all(Array.from({ length: meta?.partes || 0 }, (_, i) => Cloud.adapter.remove('fcx/' + k + '~' + i)));
      await Cloud.adapter.remove('fcx/' + k);
      cache.delete(k); FCX.versao++; FCX.aoMudar();
      Audit.registrar({ modulo: 'fcx', acao: 'excluiu', entidade: 'fcx', entidadeId: key, rotulo: 'FCX · ' + key, mudancas: [] });
      return { key, deleted: true, shared: true };
    },
    async list(prefix = '') {
      const cache = await FCX.precarregar();
      return { keys: [...cache.values()].map(c => c.chave).filter(c => c && c.startsWith(prefix)), prefix, shared: true };
    },
  },

  /* ---------- API do motor do FCX (exposta pelo iframe) ---------- */
  api() { const w = $('#fcxFrame')?.contentWindow; try { return w && w.FCXAPI && w.FCXAPI.pronto() ? w.FCXAPI : null; } catch { return null; } },
  _pronto() { FCX.versao++; if ((App.rota === 'fcx' && this.ui.aba === 'dfc') || (App.rota === 'lojas' && Lojas.ui.visao === 'ocupacao')) App.agendarRender(); MotorAluguel.agendar('FCX carregado'); },
  aoMudar() {
    if (App.rota === 'fcx' && this.ui.aba === 'dfc') App.agendarRender();
    if (!MotorAluguel._rodando) MotorAluguel.agendar('FCX alterado'); // meta/saídas mudaram → reprojeta o aluguel
    if (App.rota === 'lojas' && Lojas.ui.visao === 'ocupacao') App.agendarRender();
  },

  /* ---------- confirmações e downloads dentro do iframe ---------- */
  _confirmPend: null,
  confirmar(msg) {
    // confirm() nativo pode ser bloqueado dentro de molduras (iframe); usamos "clique duas vezes para confirmar".
    const agora = Date.now();
    if (this._confirmPend && this._confirmPend.msg === msg && agora - this._confirmPend.t < 6000) { this._confirmPend = null; return true; }
    this._confirmPend = { msg, t: agora }; UI.toast(msg + ' — clique de novo para confirmar.'); return false;
  },
  async baixar(a) {
    try { const blob = await (await fetch(a.href)).blob(); await Documento.baixarArquivo(a.download || 'arquivo', blob); } catch (e) { UI.toast('Download não concluído.'); }
  },
  imprimir(win) {
    const doc = win.document.cloneNode(true);
    $$('canvas', win.document).forEach((cv, i) => { const alvo = doc.querySelectorAll('canvas')[i]; if (alvo) { const img = doc.createElement('img'); img.src = cv.toDataURL('image/png'); img.style.maxWidth = '100%'; alvo.replaceWith(img); } });
    doc.querySelectorAll('script').forEach(s => s.remove());
    const html = '<!doctype html>' + doc.documentElement.outerHTML.replace('</body>', `<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},500)});<\/script></body>`);
    Documento.previa('Fluxo de Caixa', html, 'FCX_Esposende_' + Datas.hojeISO());
  },

  /* ---------- tela ---------- */
  /** v14: avisa (no máximo a cada 8 s) que a alteração não foi gravada por falta de permissão. */
  avisoLeitura() { const t = Date.now(); if (t - (this._avisoAt || 0) > 8000) { this._avisoAt = t; UI.toast('Seu acesso ao FCX é somente leitura: a alteração não foi gravada.'); } },
  render() {
    const a = this.ui.aba, restrito = !Auth.can('fcx.dfc.ver');
    const abas = [['fcx', 'FCX · Fluxo de Caixa'], ['dfc', 'DFC']];
    return `<div class="page-head"><div><h1>FCX · Fluxo de Caixa</h1><p>Projeção de caixa, orçamento e painel analítico — e, na aba DFC, o realizado dos extratos bancários cruzado com as premissas do FCX. Os dados ficam salvos ${Cloud.nuvem ? 'na nuvem do Painel' : 'neste navegador'} e toda gravação entra no log.</p></div></div>
      <div class="tabs" role="tablist">${abas.map(([k, r]) => `<button class="${a === k ? 'on' : ''}" role="tab" aria-selected="${a === k}" data-a="fcx-aba" data-v="${k}">${r}${restrito && k === 'dfc' ? ' <span class="pill neutral" style="margin-left:4px">GESTOR</span>' : ''}</button>`).join('')}</div>
      ${a === 'fcx' && !Auth.can('fcx.editar') ? '<div class="note" style="margin-bottom:10px">Seu acesso ao FCX é <b>somente leitura</b>: alterações feitas na planilha não são gravadas.</div>' : ''}
      ${a === 'dfc' ? FluxoDFC.render() : ''}`;
  },
  afterRender() { if (this.ui.aba === 'dfc') FluxoDFC.afterRender(); },
  /** Mostra/oculta o contêiner fixo do iframe conforme a rota e a aba. Chamado a cada App.render(). */
  sincronizar() {
    const visivel = App.rota === 'fcx' && this.ui.aba === 'fcx', host = $('#fcxHost');
    document.body.classList.toggle('fcx-on', visivel);
    if (host) host.hidden = !visivel;
    if (visivel || (App.rota === 'fcx' && this.ui.aba === 'dfc')) this.montar();
  },
  async montar() {
    const host = $('#fcxHost'); if (!host || $('#fcxFrame')) return;
    host.innerHTML = `<iframe id="fcxFrame" class="fcx-frame" title="Fluxo de Caixa Esposende"></iframe><p class="hint" id="fcxStatus" style="margin-top:8px">Carregando o FCX…</p>`;
    const fr = $('#fcxFrame');
    try {
      this.precarregar().catch(() => { });
      this.html ||= await (this.carregando ||= fetch('fcx.html').then(r => { if (!r.ok) throw new Error('fcx.html não encontrado'); return r.text(); }));
      const ponte = `<script>(function(){var P=window.parent;window.__embed=true;window.storage=P.FCX.storage;window.confirm=function(m){return P.FCX.confirmar(m)};window.alert=function(m){P.UI.toast(String(m))};window.print=function(){P.FCX.imprimir(window)};
var c=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download){P.FCX.baixar(this);return;}return c.call(this)};
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[download]');if(a){e.preventDefault();P.FCX.baixar(a);}},true);})();<\/script>
<style>.topbar{display:none!important}#app{padding-top:18px!important}</style>`;
      fr.srcdoc = this.html.replace(/<head>/i, '<head>' + ponte);
      fr.addEventListener('load', () => { const s = $('#fcxStatus'); if (s) s.textContent = 'Dica: use a navegação interna do FCX; o botão “Painel de Gestão” no topo volta ao menu.'; }, { once: true });
    } catch (e) { const s = $('#fcxStatus'); if (s) s.textContent = 'Não foi possível abrir o FCX: ' + e.message; }
  },
  /** Pré-carga em segundo plano: cache de dados e iframe prontos antes do primeiro clique. */
  preparar() {
    if (!Auth.can('fcx.ver')) return;
    const ocioso = window.requestIdleCallback || (f => setTimeout(f, 300));
    this.precarregar().then(() => ocioso(() => this.montar(), { timeout: 4000 })).catch(() => { });
  },
  acao(a, el) {
    if (a === 'fcx-aba') { this.ui.aba = el.dataset.v; return App.render(); }
    return FluxoDFC.acao(a, el);
  },
  mudanca(a, el) { return FluxoDFC.mudanca(a, el); },
  entrada(a, el) { return FluxoDFC.entrada(a, el); },
};
window.FCX = FCX; // o iframe acessa a ponte via window.parent.FCX
