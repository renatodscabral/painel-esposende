/* =====================================================================
   PAINEL DE GESTÃO | ESPOSENDE — NÚCLEO DA PLATAFORMA
   ---------------------------------------------------------------------
   Camadas (de baixo para cima):
     1. Util ............ formatação, datas, CNPJ, diff de objetos
     2. Cloud ........... adaptadores de dados (Local | banco compartilhado plugável, ex.: Supabase*)
     3. Auth ............ usuário logado (login por CPF) + perfis MASTER / OPERACIONAL + permissões
     4. Audit ........... log oculto: quem, o quê, quando (toda gravação)
     5. Repo ............ repositório com cache em memória + auditoria automática
     6. Servicos ........ arquivos, IA (resumo de contrato/apólice), documentos
                          imprimíveis, Receita Federal (gancho)
     7. UI .............. modal, toast, confirmação
   Os módulos (pessoal.js, lojas.js, fcx.js) só falam com Repo/Auth/Servicos
   — nunca com o banco diretamente. Trocar de nuvem = trocar o adaptador.
   ===================================================================== */

/* ============================== 1. UTIL ============================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const Fmt = {
  brl: n => (n == null || n === '' || isNaN(n)) ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  brl0: n => (n == null || n === '' || isNaN(n)) ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }),
  num: (n, d = 0) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }),
  pct: (n, d = 2) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%',
  data: iso => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return d ? `${d}/${m}/${y}` : '—'; },
  dataHora: iso => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); },
  horas: h => { if (h == null || isNaN(h)) return '—'; const s = h < 0 ? '−' : '+'; const a = Math.abs(h); const hh = Math.floor(a); const mm = Math.round((a - hh) * 60); return `${s}${hh}h${String(mm).padStart(2, '0')}`; },
};

const Datas = {
  hoje: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); },
  hojeISO: () => Datas.iso(Datas.hoje()),
  iso: d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'),
  de: iso => { if (!iso) return null; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d || 1); },
  addMeses: (d, n) => { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; },
  addAnos: (d, n) => Datas.addMeses(d, n * 12),
  dias: (a, b) => Math.round((b - a) / 864e5),
  mesesEntre: (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0),
  tempoDeCasa: iso => {
    const a = Datas.de(iso); if (!a) return '—';
    const m = Datas.mesesEntre(a, Datas.hoje()); const anos = Math.floor(m / 12), meses = m % 12;
    return (anos ? anos + (anos > 1 ? ' anos' : ' ano') : '') + (anos && meses ? ' e ' : '') + (meses || !anos ? meses + (meses === 1 ? ' mês' : ' meses') : '');
  },
};

/** CNPJ: validação dos dígitos verificadores (módulo 11). */
const CNPJ = {
  limpar: s => String(s || '').replace(/\D/g, ''),
  formatar(s) { const d = CNPJ.limpar(s); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : String(s || ''); },
  valido(s) {
    const d = CNPJ.limpar(s); if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
    const calc = n => { let soma = 0, peso = n - 7; for (let i = 0; i < n; i++) { soma += +d[i] * peso--; if (peso < 2) peso = 9; } const r = soma % 11; return r < 2 ? 0 : 11 - r; };
    return calc(12) === +d[12] && calc(13) === +d[13];
  },
};

/**
 * CSV — leitura e geração (camada Util).
 * ler(): aceita separador vírgula, ponto e vírgula (padrão do Excel em pt-BR) ou tab, campos entre aspas
 * com aspas duplicadas, quebras CRLF/LF e BOM. Devolve { cabecalho, linhas:[{Coluna: valor}], separador }.
 */
const CSV = {
  decodificar(buf) { const u = new TextDecoder('utf-8').decode(buf); return u.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(buf) : u; },
  detectarSeparador(txt) {
    const primeira = txt.split(/\r?\n/)[0] || '', conta = c => primeira.split(c).length - 1;
    return [';', ',', '\t'].sort((a, b) => conta(b) - conta(a))[0];
  },
  ler(texto, { separador } = {}) {
    const txt = String(texto || '').replace(/^\uFEFF/, ''), sep = separador || this.detectarSeparador(txt);
    const rows = []; let row = [], campo = '', aspas = false;
    for (let i = 0; i < txt.length; i++) {
      const c = txt[i];
      if (aspas) { if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += c; continue; }
      if (c === '"') aspas = true;
      else if (c === sep) { row.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; row.push(campo); rows.push(row); row = []; campo = ''; }
      else campo += c;
    }
    if (campo !== '' || row.length) { row.push(campo); rows.push(row); }
    const uteis = rows.filter(r => r.some(v => String(v).trim() !== ''));
    if (!uteis.length) return { cabecalho: [], linhas: [], separador: sep };
    const cabecalho = uteis[0].map(h => h.trim());
    return { cabecalho, separador: sep, linhas: uteis.slice(1).map(r => Object.fromEntries(cabecalho.map((h, i) => [h, (r[i] ?? '').trim()]))) };
  },
  /** Gera CSV (RFC 4180) a partir de uma matriz; aspas só quando necessário. */
  gerar(matriz, sep = ',') {
    const q = v => { const s = String(v ?? ''); return /["\r\n]/.test(s) || s.includes(sep) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return matriz.map(r => r.map(q).join(sep)).join('\r\n') + '\r\n';
  },
};

/**
 * WhatsApp (camada Util) — gera o link de compartilhamento wa.me.
 * Sem telefone, o WhatsApp abre para o usuário escolher o contato/grupo; com telefone (DDI+DDD+número), abre direto na conversa.
 * Produção: para disparo automático sem clique, usar a WhatsApp Business API numa Edge Function.
 */
const WhatsApp = {
  link(texto, telefone = '') {
    const msg = encodeURIComponent(String(texto ?? '')), fone = String(telefone || '').replace(/\D/g, '');
    return fone ? `https://wa.me/${fone}?text=${msg}` : `https://wa.me/?text=${msg}`;
  },
};

/**
 * Texto de PDF (pdf.js, carregado sob demanda). Devolve o texto página a página; se o PDF for
 * digitalizado (quase sem texto), devolve também imagens das primeiras páginas para leitura por IA.
 * Páginas são lidas em paralelo (lotes de 8) para contratos longos.
 */
const PdfTexto = {
  async extrair(fileOuBlob, { maxImgs = 4, onProgresso = () => { } } = {}) {
    const pdfjs = await Libs.pdf();
    const doc = await pdfjs.getDocument({ data: await fileOuBlob.arrayBuffer() }).promise;
    const paginas = new Array(doc.numPages);
    for (let ini = 1; ini <= doc.numPages; ini += 8) {
      const lote = [];
      for (let i = ini; i < Math.min(ini + 8, doc.numPages + 1); i++) lote.push(doc.getPage(i).then(pg => pg.getTextContent()).then(c => { paginas[i - 1] = `[Página ${i}]\n` + c.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+/g, ' '); }));
      await Promise.all(lote); onProgresso(Math.min(ini + 7, doc.numPages), doc.numPages);
    }
    const texto = paginas.join('\n\n').trim(), imagens = [];
    if (texto.replace(/\[Página \d+\]|\s/g, '').length < 300) {
      for (let i = 1; i <= Math.min(doc.numPages, maxImgs); i++) {
        const pg = await doc.getPage(i), vp = pg.getViewport({ scale: 1.6 });
        const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
        await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        imagens.push(await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85)));
      }
    }
    return { texto, paginas: doc.numPages, imagens };
  },
};

/** Diferença campo a campo entre dois objetos (para o log de auditoria). */
function diffObjetos(antes, depois, prefixo = '', saida = []) {
  const a = antes || {}, b = depois || {};
  const chaves = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of chaves) {
    if (['atualizadoEm', 'atualizadoPor', 'criadoEm', 'criadoPor'].includes(k)) continue;
    const va = a[k], vb = b[k], campo = prefixo ? prefixo + '.' + k : k;
    const objA = va && typeof va === 'object' && !Array.isArray(va), objB = vb && typeof vb === 'object' && !Array.isArray(vb);
    if (objA || objB) { diffObjetos(objA ? va : {}, objB ? vb : {}, campo, saida); continue; }
    if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) {
      const curto = v => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s.length > 140 ? s.slice(0, 137) + '…' : s; };
      saida.push({ campo, de: curto(va), para: curto(vb) });
    }
  }
  return saida;
}

/* ============================== 2. CLOUD ============================== */
/*
  Interface comum de todos os adaptadores (documentos JSON em caminhos
  "colecao/doc" ou "colecao/doc/subcolecao/doc"):
    get(path) → objeto | null          set(path, obj)       remove(path)
    list(colPath, {orderBy, dir, limit}) → [{id, ...}]
    watch(colPath, cb) → unsubscribe   (cb recebe [{id, ...}] a cada mudança)
*/
/** Adaptador padrão: navegador local (localStorage). Para uso compartilhado, plugue um banco (window.PAINEL_ADAPTER). */
class LocalAdapter {
  constructor() { this.tipo = 'local'; this.rotulo = 'Somente neste navegador'; this.ouvintes = new Map(); this.mem = {}; }
  _k(p) { return 'esp-painel:' + p; }
  _ler(p) { try { const v = localStorage.getItem(this._k(p)); return v ? JSON.parse(v) : (this.mem[p] ?? null); } catch { return this.mem[p] ?? null; } }
  _gravar(p, v) { this.mem[p] = v; try { v == null ? localStorage.removeItem(this._k(p)) : localStorage.setItem(this._k(p), JSON.stringify(v)); } catch { /* memória */ } }
  _indice(col) { return this._ler('__idx/' + col) || []; }
  async get(path) { const v = this._ler(path); return v ? { id: path.split('/').pop(), ...v } : null; }
  async set(path, obj) {
    const col = path.split('/').slice(0, -1).join('/'), id = path.split('/').pop();
    this._gravar(path, obj); const idx = this._indice(col); if (!idx.includes(id)) { idx.push(id); this._gravar('__idx/' + col, idx); }
    this._notificar(col);
  }
  async remove(path) {
    const col = path.split('/').slice(0, -1).join('/'), id = path.split('/').pop();
    this._gravar(path, null); this._gravar('__idx/' + col, this._indice(col).filter(x => x !== id)); this._notificar(col);
  }
  async list(col, o = {}) {
    let r = this._indice(col).map(id => { const v = this._ler(col + '/' + id); return v ? { id, ...v } : null; }).filter(Boolean);
    if (o.orderBy) r.sort((a, b) => (a[o.orderBy] > b[o.orderBy] ? 1 : -1) * (o.dir === 'desc' ? -1 : 1));
    return o.limit ? r.slice(0, o.limit) : r;
  }
  watch(col, cb) {
    if (!this._ouvindoAbas) { this._ouvindoAbas = true; window.addEventListener('storage', e => { const m = (e.key || '').match(/^esp-painel:(?!__idx\/)(.+)\/[^/]+$/); if (m) this._notificar(m[1]); }); } // outras abas do mesmo navegador
    if (!this.ouvintes.has(col)) this.ouvintes.set(col, new Set());
    this.ouvintes.get(col).add(cb); this.list(col).then(cb);
    return () => this.ouvintes.get(col).delete(cb);
  }
  _notificar(col) { const s = this.ouvintes.get(col); if (s) this.list(col).then(r => s.forEach(cb => cb(r))); }
  watchDoc(path, cb) { const col = path.split('/').slice(0, -1).join('/'); const f = () => this.get(path).then(cb); return this.watch(col, f); }
}

/* Banco compartilhado (v15): SupabaseAdapter em nuvem.js — ligado quando config.js traz SUPABASE_URL e SUPABASE_ANON_KEY. */

const Cloud = {
  adapter: null,
  caps: { db: null, user: null, assets: null, sample: null, downloads: null },
  /**
   * Escolhe o adaptador de dados: Supabase quando a instalação traz SUPABASE_URL e SUPABASE_ANON_KEY
   * (config.js → window.PAINEL_CONFIG); um adaptador próprio via window.PAINEL_ADAPTER; senão, este navegador.
   */
  async init() {
    const fab = typeof window.PAINEL_ADAPTER === 'function' ? window.PAINEL_ADAPTER : Nuvem.configurado ? () => Nuvem.conectar() : null;
    this.adapter = fab ? await fab() : new LocalAdapter();
    return this.adapter;
  },
  get nuvem() { return this.adapter && this.adapter.tipo === 'nuvem'; },
};

/* ============================== 3. AUTH ============================== */
/*
  Perfis: MASTER (acesso total, inclusive Gestão de Acessos) e OPERACIONAL (matriz Ler/Modificar/Excluir
  por módulo, definida na Gestão de Acessos). Internamente o MASTER usa a lista 'GESTOR' (= '*').
  O login é por CPF (Sessao, acessos.js); a matriz vira as permissões consultadas com Auth.can().
*/
const PERMISSOES = {
  GESTOR: ['*'],
  OPERACIONAL: [
    'pessoal.ver', 'pessoal.editar',          // equipe (sem salário)
    'pdi.ver',                                // vê PDI, não avalia
    'lojas.ver', 'lojas.editar',              // dados gerais, adquirentes, despesas
    'fcx.ver',
    'retaguarda.ver', 'retaguarda.credsystem.importar', 'retaguarda.credsystem.editar',   // Módulo 4
    'retaguarda.faltas.lancar', 'retaguarda.caixas.editar',                              // sem aprovar/excluir faltas
    'retaguarda.ieo.ver',                                                                 // vê o IEO; extratos/DFC (Módulo 3) só GESTOR
  ],
  // Lista de referência de todas as permissões usadas no código:
  _catalogo: [
    'pessoal.ver', 'pessoal.editar', 'pessoal.excluir', 'pessoal.salario.ver', 'pessoal.salario.editar', 'pessoal.parametros',
    'pdi.ver', 'pdi.avaliar', 'lojas.ver', 'lojas.editar', 'lojas.excluir', 'lojas.contrato.editar',
    'lojas.arquivos', 'lojas.importar', 'ia.resumo', 'fcx.ver',
    'lojas.contratos.ver', 'lojas.contratos.editar',   // contratos de locação + radar (só GESTOR)
    'retaguarda.ver', 'retaguarda.credsystem.importar', 'retaguarda.credsystem.editar', 'retaguarda.faltas.lancar',
    'retaguarda.faltas.status', 'retaguarda.faltas.excluir', 'retaguarda.caixas.editar',
    'fcx.dfc.ver', 'fcx.dfc.importar', 'fcx.dfc.contas', 'fcx.dfc.regras',   // Módulo 3 · aba DFC (só GESTOR)
    'retaguarda.adq.ver', 'retaguarda.adq.taxas', 'retaguarda.adq.importar',   // auditoria de adquirentes (só GESTOR)
    'retaguarda.ieo.ver', 'retaguarda.ieo.matriz', 'retaguarda.ieo.lancar', 'retaguarda.ieo.fechar', 'retaguarda.ieo.laudo',
    'auditoria.ver', 'backup.exportar', 'backup.restaurar',
    'acessos.gerir',                                                         // Gestão de Acessos (só Master/Admin)
    'lojas.contratos.excluir', 'fcx.editar', 'fcx.excluir',                  // v14: inativar contrato/apólice · gravar/excluir no FCX
    'integracoes.gerir',                                                     // v15: Configurações de Integração (só Master)
  ],
};

/**
 * v14 · Matriz de permissões por módulo (Gestão de Acessos). Cada nível inclui os anteriores:
 * Ler ⊂ Modificar ⊂ Excluir. As permissões abaixo são as que os módulos já consultam com Auth.can().
 * Ficam fora da matriz (só Master): salários, parâmetros de RH, auditoria, backup e a própria Gestão de Acessos.
 */
const MATRIZ_MODULOS = [
  { id: 'pdi', curto: 'PDI', rotulo: 'Pessoal e PDI', num: 'Módulo 1', ler: ['pessoal.ver', 'pdi.ver'], modificar: ['pessoal.editar', 'pdi.avaliar'], excluir: ['pessoal.excluir'] },
  { id: 'lojas', curto: 'Lojas', rotulo: 'Gestão de Lojas', num: 'Módulo 2', ler: ['lojas.ver'], modificar: ['lojas.editar', 'lojas.arquivos', 'ia.resumo'], excluir: ['lojas.excluir', 'lojas.importar'] },
  { id: 'contratos', curto: 'Contratos', rotulo: 'Contratos e seguros', num: 'Módulo 3', ler: ['lojas.contratos.ver'], modificar: ['lojas.contratos.editar', 'lojas.contrato.editar', 'lojas.arquivos', 'ia.resumo'], excluir: ['lojas.contratos.excluir'] },
  { id: 'fcx', curto: 'FCX', rotulo: 'FCX · Fluxo de Caixa', num: 'Módulo 4', ler: ['fcx.ver', 'fcx.dfc.ver'], modificar: ['fcx.editar', 'fcx.dfc.importar', 'fcx.dfc.contas', 'fcx.dfc.regras'], excluir: ['fcx.excluir'] },
  { id: 'retaguarda', curto: 'Retaguarda', rotulo: 'Retaguarda Financeira', num: 'Módulo 5',
    ler: ['retaguarda.ver', 'retaguarda.ieo.ver', 'retaguarda.adq.ver'],
    modificar: ['retaguarda.credsystem.importar', 'retaguarda.credsystem.editar', 'retaguarda.faltas.lancar', 'retaguarda.faltas.status', 'retaguarda.caixas.editar', 'retaguarda.ieo.lancar', 'retaguarda.ieo.matriz', 'retaguarda.ieo.fechar', 'retaguarda.ieo.laudo', 'retaguarda.adq.importar', 'retaguarda.adq.taxas'],
    excluir: ['retaguarda.faltas.excluir'] },
];
const NIVEIS_ACESSO = ['', 'ler', 'modificar', 'excluir'];
/** Padrão de um novo usuário OPERACIONAL (equivale ao perfil OPERACIONAL das versões anteriores). */
const MATRIZ_PADRAO = { pdi: 'ler', lojas: 'modificar', contratos: '', fcx: 'ler', retaguarda: 'modificar' };
function permissoesDaMatriz(m = {}) {
  const out = new Set();
  for (const mod of MATRIZ_MODULOS) {
    const n = NIVEIS_ACESSO.indexOf(m[mod.id] || ''); if (n <= 0) continue;
    mod.ler.forEach(p => out.add(p)); if (n >= 2) mod.modificar.forEach(p => out.add(p)); if (n >= 3) mod.excluir.forEach(p => out.add(p));
  }
  return [...out];
}

const Auth = {
  id: null, nome: '', avatar: '', perfilReal: 'OPERACIONAL', simulado: null, usuario: null, funcionario: null,
  matriz: PERMISSOES,
  get perfil() { return this.simulado || this.perfilReal; },
  async init() { /* identidade vem do login (Sessao.entrar) */ },
  /** Ajuste opcional da matriz por perfil (config/permissoes). Lido só DEPOIS do login. */
  async carregarConfig() { try { const cfg = await Cloud.adapter.get('config/permissoes'); if (cfg && cfg.matriz) this.matriz = { ...PERMISSOES, ...cfg.matriz }; } catch { } },
  can(perm) {
    if (!this.id) return false;
    const lista = this.matriz[this.perfil] || [];
    return lista.some(p => p === '*' || p === perm || (p.endsWith('.*') && perm.startsWith(p.slice(0, -1))));
  },
  /** Nomes para o log: usuário → funcionário do Módulo 1 (ou nome do Master avulso). */
  async nomes(ids) {
    const out = {};
    ids.forEach(i => { const u = Repo.get('usuarios', i), f = u?.funcionarioId ? Repo.get('funcionarios', u.funcionarioId) : null; out[i] = f?.nome || u?.nome || (i === this.id ? this.nome : 'Usuário removido'); });
    return out;
  },
  simular(perfil) { this.simulado = perfil === this.perfilReal ? null : perfil; },
  /** Aplica o usuário que acabou de entrar (MASTER = todas as permissões; OPERACIONAL = matriz). */
  aplicarUsuario(u, f) {
    this.id = u.id; this.usuario = u; this.funcionario = f || null; this.nome = f?.nome || u.nome || 'Usuário'; this.simulado = null;
    this.perfilReal = u.perfil === 'MASTER' ? 'GESTOR' : 'OPERACIONAL';
    this.matriz = { ...this.matriz, OPERACIONAL: u.perfil === 'MASTER' ? PERMISSOES.OPERACIONAL : permissoesDaMatriz(u.permissoes || {}) };
  },
  limpar() { this.id = null; this.usuario = null; this.funcionario = null; this.nome = ''; this.simulado = null; this.perfilReal = 'OPERACIONAL'; this.matriz = PERMISSOES; },
};

/* ============================== 4. AUDIT ============================== */
/*
  Log oculto. Cada evento: { ts, uid, perfil, modulo, acao, entidade,
  entidadeId, rotulo, mudancas:[{campo,de,para}] }.
  Armazenamento: auditoria/<uid>/dias/<AAAA-MM-DD>[_n] → { eventos:[...] }
  (agrupado por usuário/dia para respeitar o limite de documentos).
  Regras do banco: cada usuário só ESCREVE no próprio ramo; só GESTOR LÊ.
*/
const Audit = {
  _fila: Promise.resolve(), _cache: {}, MAX: 350,
  registrar(ev) {
    const evento = { ts: new Date().toISOString(), uid: Auth.id, perfil: Auth.perfilReal, ...ev };
    this._fila = this._fila.then(() => this._gravar(evento)).catch(e => console.warn('auditoria', e));
    return this._fila;
  },
  async _gravar(evento) {
    const dia = evento.ts.slice(0, 10), base = `auditoria/${Auth.id}/dias/`;
    let parte = this._cache[dia]?.parte ?? 0, doc = this._cache[dia]?.doc;
    if (!doc) { // descobre a última parte do dia
      for (; ; parte++) { const d = await Cloud.adapter.get(base + dia + (parte ? '_' + parte : '')); if (!d) { doc = { dia, eventos: [] }; break; } if (d.eventos.length < this.MAX) { doc = d; break; } }
    }
    if (doc.eventos.length >= this.MAX) { parte++; doc = { dia, eventos: [] }; }
    doc = { dia, parte, uid: Auth.id, eventos: [...doc.eventos, evento] };
    delete doc.id;
    await Cloud.adapter.set(base + dia + (parte ? '_' + parte : ''), doc);
    this._cache[dia] = { parte, doc };
    // marca o usuário como "ativo" (lista usada pela tela de auditoria)
    await Presenca.tocar();
  },
  /** Lê eventos de todos os usuários (somente GESTOR tem leitura). */
  async carregar({ dias = 31 } = {}) {
    const usuarios = await Cloud.adapter.list('presenca').catch(() => []);
    const ids = new Set(usuarios.map(u => u.id)); ids.add(Auth.id);
    const todos = [];
    for (const id of ids) {
      const docs = await Cloud.adapter.list(`auditoria/${id}/dias`, { orderBy: 'dia', dir: 'desc', limit: dias }).catch(() => []);
      docs.forEach(d => (d.eventos || []).forEach(e => todos.push(e)));
    }
    return todos.sort((a, b) => b.ts.localeCompare(a.ts));
  },
};

/** Registro de quem já acessou (para a tela de usuários/auditoria). */
const Presenca = {
  _feito: false,
  async tocar() {
    if (this._feito || !Auth.id || Auth.id === 'anonimo') return;
    this._feito = true;
    try {
      const atual = await Cloud.adapter.get('presenca/' + Auth.id);
      const hoje = Datas.hojeISO();
      if (!atual || atual.ultimoDia !== hoje || atual.perfil !== Auth.perfilReal)
        await Cloud.adapter.set('presenca/' + Auth.id, { uid: Auth.id, perfil: Auth.perfilReal, primeiroAcesso: atual?.primeiroAcesso || new Date().toISOString(), ultimoDia: hoje });
    } catch { /* leitura/escrita pode ser negada a perfis sem escrita */ }
  },
};

/* ============================== 5. REPO ============================== */
/*
  Repositório com cache em memória alimentado por assinaturas em tempo real.
  TODA gravação passa por Repo.salvar/excluir → grava + registra auditoria.
*/
const Repo = {
  cols: {},           // nome → Map(id → doc)
  prontas: new Set(), // coleções que já receberam o 1º snapshot
  rev: 0,             // sobe a cada mudança em qualquer coleção (cache de cálculos derivados)
  _unsubs: [],
  assinar(col) {
    if (this.cols[col]) return;
    this.cols[col] = new Map();
    const un = Cloud.adapter.watch(col, docs => {
      this.cols[col] = new Map(docs.map(d => [d.id, d])); this.rev++;
      this.prontas.add(col); App.agendarRender();
    }, err => { console.warn('assinatura', col, err); this.prontas.add(col); App.agendarRender(); });
    this._unsubs.push(un);
  },
  todos(col) { return [...(this.cols[col] || new Map()).values()]; },
  /** Relê a coleção direto da base (sem esperar o próximo snapshot da assinatura). */
  async recarregar(col) { const docs = await Cloud.adapter.list(col); this.cols[col] = new Map(docs.map(d => [d.id, d])); this.rev++; this.prontas.add(col); return docs.length; },
  get(col, id) { return (this.cols[col] || new Map()).get(id) || null; },
  async salvar(col, id, dados, meta = {}) {
    const antes = this.get(col, id) || (meta.antes ?? null);
    const doc = { ...clone(dados), atualizadoEm: new Date().toISOString(), atualizadoPor: Auth.id };
    if (!antes) { doc.criadoEm = doc.atualizadoEm; doc.criadoPor = Auth.id; }
    delete doc.id;
    Sync.ocupado(true);
    try { await Cloud.adapter.set(col + '/' + id, doc); }
    catch (e) { Sync.ocupado(false); UI.toast(msgErro(e)); throw e; }
    if (this.cols[col]) this.cols[col].set(id, { id, ...doc }); this.rev++;
    const mudancas = diffObjetos(antes, doc);
    if ((antes && !mudancas.length) || meta.semAudit) { Sync.ocupado(false); if (meta.semAudit) App.agendarRender(); return; } // semAudit: lote que registra um log resumido
    await Audit.registrar({ modulo: meta.modulo || col, acao: antes ? 'alterou' : 'criou', entidade: col, entidadeId: id, rotulo: meta.rotulo || id, mudancas: mudancas.slice(0, 60), detalhe: meta.detalhe || '' });
    Sync.ocupado(false); App.agendarRender();
  },
  async excluir(col, id, meta = {}) {
    const antes = this.get(col, id);
    Sync.ocupado(true);
    await Cloud.adapter.remove(col + '/' + id);
    if (this.cols[col]) this.cols[col].delete(id); this.rev++;
    await Audit.registrar({ modulo: meta.modulo || col, acao: 'excluiu', entidade: col, entidadeId: id, rotulo: meta.rotulo || id, mudancas: [], detalhe: 'Registro removido' + (antes ? '' : ' (não estava em cache)') });
    Sync.ocupado(false); App.agendarRender();
  },
};
function msgErro(e) {
  const c = e && e.code;
  if (c === 'invalid_argument') return 'Seu perfil não tem permissão para gravar este dado.';
  if (c === 'quota_exceeded') return 'Limite de registros do banco atingido. Faça um backup e remova registros antigos.';
  if (c === 'resource_exhausted') return 'Muitas gravações seguidas. Aguarde alguns segundos e tente de novo.';
  return 'Não foi possível salvar: ' + ((e && e.message) || 'erro desconhecido');
}
const Sync = {
  n: 0,
  ocupado(b) { this.n = Math.max(0, this.n + (b ? 1 : -1)); const el = $('#sync'); if (el) el.classList.toggle('busy', this.n > 0); const t = $('#syncTxt'); if (t) t.textContent = this.n ? 'salvando…' : (Cloud.nuvem ? 'salvo na nuvem' : 'salvo neste navegador'); },
};

/* ============================ 6. SERVIÇOS ============================ */
const Libs = {
  _p: {},
  /** Bibliotecas: pasta local da instalação (window.PAINEL_LIBS = 'libs/', funciona sem internet) ou CDN. */
  src(arquivo, cdn) { return window.PAINEL_LIBS ? window.PAINEL_LIBS + arquivo : cdn; },
  carregar(src) {
    return this._p[src] ||= new Promise((ok, err) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => err(new Error('Falha ao carregar ' + src)); document.head.appendChild(s); });
  },
  async pdf() {
    // pdf.js em modo "fake worker" (o worker roda na página: compatível com o CSP do painel)
    await this.carregar(this.src('pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'));
    await this.carregar(this.src('pdf.worker.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'));
    return window.pdfjsLib;
  },
  async xlsx() { await this.carregar(this.src('xlsx.full.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js')); return window.XLSX; },
  async chart() { await this.carregar(this.src('chart.umd.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js')); window.Chart.defaults.font.family = "'IBM Plex Sans','Segoe UI',sans-serif"; return window.Chart; },
};

const Arquivos = {
  get podeEnviar() { return !!Cloud.caps.assets && Auth.can('lojas.arquivos'); },
  /** Envia o arquivo para o armazenamento do painel e devolve a referência a gravar no registro. */
  async enviar(file) {
    const a = Cloud.caps.assets; if (!a) throw new Error('Armazenamento de arquivos indisponível neste acesso.');
    const r = await a.upload(file);
    return { assetId: r.id, url: r.url, caminho: r.caminho || null, nome: file.name, tamanho: file.size, tipo: r.contentType, enviadoEm: new Date().toISOString(), enviadoPor: Auth.id };
  },
  url(ref) { return ref ? (ref.assetId ? '/_blob/' + ref.assetId : ref.url) : ''; },
  /** Extrai texto de um PDF (ver PdfTexto, camada Util). */
  extrairPdf(fileOuBlob, maxImgs = 4) { return PdfTexto.extrair(fileOuBlob, { maxImgs }); },
  async blobDe(ref) { const r = await fetch(Arquivos.url(ref)); if (!r.ok) throw new Error('Não consegui abrir o arquivo salvo.'); return r.blob(); },
};

/** Leitura inteligente de documentos via IA. Só aparece quando um provedor de IA está configurado (Cloud.caps.sample). */
const IA = {
  get disponivel() { return !!Cloud.caps.sample && Auth.can('ia.resumo'); },
  PROMPTS: {
    contrato: `Você é analista jurídico-financeiro da Esposende, rede varejista de calçados do Nordeste (lojas de rua, shopping e hipermercado).
Leia o CONTRATO DE LOCAÇÃO e responda APENAS com JSON válido neste formato:
{"resumo":"3 a 5 frases objetivas","partes":{"locador":"","locatario":""},
"vigencia":{"inicio":"AAAA-MM-DD ou null","fim":"AAAA-MM-DD ou null","prazoMeses":numero ou null},
"financeiro":{"aluguelMensal":numero ou null,"aluguelPercentual":"texto ou null","indiceReajuste":"IGP-M|IPCA|INPC|outro","periodicidadeReajuste":"","garantia":"","encargos":["condomínio, fundo de promoção, 13º aluguel, IPTU..."]},
"pontosCriticos":[{"titulo":"","detalhe":"","clausula":"nº da cláusula se houver","severidade":"alta|media|baixa"}],
"prazosImportantes":[{"evento":"","data":"AAAA-MM-DD ou null","detalhe":""}],
"recomendacoes":["ação prática para o gestor"]}
Priorize: multa por rescisão antecipada, renovação e ação renovatória (prazos da Lei 8.245/91), aluguel percentual/13º aluguel e fundo de promoção (shopping), res sperata/luvas, índice e data-base de reajuste, garantias, obrigações de obra/reforma, exclusividade/raio, aviso prévio e penalidades. Use valores em reais como número. Não invente: se não constar, use null.`,
    apolice: `Você é analista de riscos da Esposende, rede varejista de calçados do Nordeste.
Leia a APÓLICE DE SEGURO e responda APENAS com JSON válido neste formato:
{"resumo":"3 a 5 frases objetivas","seguradora":"","numeroApolice":"","vigencia":{"inicio":"AAAA-MM-DD ou null","fim":"AAAA-MM-DD ou null"},
"premioTotal":numero ou null,"coberturas":[{"nome":"","limite":numero ou null,"franquia":"texto"}],
"pontosCriticos":[{"titulo":"","detalhe":"","clausula":"","severidade":"alta|media|baixa"}],
"exclusoesRelevantes":["..."],"obrigacoesSegurado":["..."],"recomendacoes":["ação prática para o gestor"]}
Priorize: coberturas de incêndio, roubo/furto qualificado de mercadorias, danos elétricos, responsabilidade civil, lucros cessantes; franquias altas; exclusões que afetem loja de calçados; prazo de aviso de sinistro. Não invente: se não constar, use null.`,
  },
  /** Gera o resumo. `tipo` = 'contrato' | 'apolice'. */
  async resumir(tipo, fileOuBlob, onStatus = () => { }) {
    const r = await this.executar(this.PROMPTS[tipo], fileOuBlob, onStatus);
    return { ...r.json, geradoEm: new Date().toISOString(), geradoPor: Auth.id, paginas: r.paginas };
  },
  /**
   * Motor genérico: extrai o texto do PDF (PdfTexto), monta prompt + documento e pede JSON à IA.
   * Usado pelos resumos (contrato/apólice) e pelo Leitor de Contratos (CONTRATO_PROMPT, contratos.js).
   */
  async executar(prompt, fileOuBlob, onStatus = () => { }) {
    const sample = Cloud.caps.sample; if (!sample) throw new Error('A leitura por IA está desligada: o Master liga em Configurações de Integração.');
    onStatus('Lendo o PDF…');
    const { texto, paginas, imagens } = await PdfTexto.extrair(fileOuBlob, { onProgresso: (i, n) => n > 8 && onStatus(`Lendo o PDF… página ${i} de ${n}`) });
    const lim = await sample.limits().catch(() => null);
    const maxBytes = (lim && lim.maxInputBytes) || 180000;
    const cabe = Math.floor((maxBytes - new TextEncoder().encode(prompt).length - 2000) / 1.15); // margem para acentos (UTF-8)
    const corpo = texto.length > cabe ? texto.slice(0, cabe) + '\n[texto truncado]' : texto;
    const opts = { modelTier: 'complex' };
    if (imagens.length) {
      if (!lim || !lim.images) throw new Error('O PDF parece ser digitalizado (sem texto) e este acesso não envia imagens para a IA.');
      opts.images = imagens.slice(0, lim.images.maxCount);
    }
    onStatus(`Analisando ${paginas} página(s) com IA…`);
    const input = prompt + '\n\n--- DOCUMENTO ---\n' + (imagens.length ? '(documento digitalizado: veja as imagens anexas)' : corpo);
    const json = await sample.json(input, opts);
    return { json, paginas, texto: corpo, digitalizado: !!imagens.length };
  },
};

/**
 * Documentos imprimíveis (Parecer PDI, Ficha da Loja): abre a prévia e imprime
 * (Imprimir / Salvar como PDF); onde a impressão direta não é permitida, baixa um .html que abre já imprimindo.
 */
const Documento = {
  montar(titulo, corpo) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(titulo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
@page{size:A4;margin:16mm 14mm;}
*{box-sizing:border-box;} body{font-family:'IBM Plex Sans',Arial,sans-serif;color:#151934;font-size:12.5px;line-height:1.55;margin:0;padding:24px;background:#fff;}
h1,h2,h3{font-family:'Sora',Arial,sans-serif;color:#1B2362;margin:0;} h1{font-size:22px;} h2{font-size:15px;margin:22px 0 8px;padding-bottom:5px;border-bottom:2px solid #1B2362;} h3{font-size:13px;}
.head{display:flex;justify-content:space-between;align-items:center;gap:16px;padding-bottom:14px;border-bottom:1px solid #D9DCEA;margin-bottom:18px;}
.head img{height:40px;} .meta{font-size:11px;color:#585E7F;text-align:right;}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 18px;} .grid .t{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:#8E93AE;font-weight:600;} .grid .d{font-weight:500;}
table{width:100%;border-collapse:collapse;font-size:11.5px;} th{text-align:left;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:#585E7F;border-bottom:1.5px solid #1B2362;padding:6px 8px;} td{padding:6px 8px;border-bottom:1px solid #ECEEF5;vertical-align:top;}
.heat{border-collapse:separate;border-spacing:3px;} .heat td,.heat th{border:0;text-align:center;} .heat th.r{text-align:left;color:#151934;text-transform:none;letter-spacing:0;font-size:11.5px;}
.c{display:inline-block;min-width:34px;padding:5px 0;border-radius:5px;font-family:'IBM Plex Mono',monospace;font-weight:600;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.h0{background:#EEF0F8;color:#8E93AE}.h1{background:#D9DEF5}.h2{background:#B3BDEB}.h3{background:#7F8FDB;color:#fff}.h4{background:#4A5CC4;color:#fff}.h5{background:#1B2362;color:#fff}
.box{border:1px solid #D9DCEA;border-radius:10px;padding:12px 14px;margin:8px 0;break-inside:avoid;} .box.ok{border-left:4px solid #1D7A4E;} .box.foco{border-left:4px solid #C08A1E;}
.pill{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:#E8EAF6;color:#1B2362;}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:46px;} .sign div{border-top:1px solid #151934;padding-top:6px;font-size:11px;text-align:center;}
.foot{margin-top:26px;font-size:10px;color:#8E93AE;text-align:center;}
ul{margin:4px 0;padding-left:18px;} .big{font-family:'Sora';font-size:30px;font-weight:700;color:#1B2362;}
@media print{body{padding:0;} .noprint{display:none;}}
</style></head><body>${corpo}
<script>window.addEventListener('load',function(){setTimeout(function(){try{window.print()}catch(e){}},500)});<\/script></body></html>`;
  },
  cabecalho(titulo, subtitulo) {
    return `<div class="head"><img src="${LOGO_NAVY}" alt="Esposende"><div class="meta"><b style="font-size:13px;color:#1B2362">${esc(titulo)}</b><br>${esc(subtitulo || '')}<br>Emitido em ${new Date().toLocaleString('pt-BR')}</div></div>`;
  },
  /** Abre prévia; o botão imprime (ou baixa o arquivo para imprimir, quando houver o serviço de downloads). */
  previa(titulo, htmlCompleto, nomeArquivo) {
    UI.modal({
      titulo: 'Prévia — ' + titulo, largo: true,
      corpo: `<iframe class="preview-frame" title="Prévia do documento" sandbox="allow-same-origin"></iframe>
        <p class="hint" style="margin-top:10px;">${Cloud.caps.downloads ? 'O arquivo baixado abre com a janela de impressão: escolha a impressora ou “Salvar como PDF”.' : 'A janela de impressão do navegador será aberta.'}</p>`,
      acoes: [{ rotulo: 'Fechar', classe: 'sec' }, { rotulo: Cloud.caps.downloads ? 'Baixar para imprimir' : 'Imprimir', acao: () => this.emitir(htmlCompleto, nomeArquivo, titulo), fechar: false }],
      aoAbrir: m => { $('iframe', m).srcdoc = htmlCompleto.replace(/<script>window\.addEventListener\('load'[\s\S]*?<\/script>/, ''); },
    });
  },
  async emitir(html, nomeArquivo, titulo) {
    const dl = Cloud.caps.downloads;
    if (dl) {
      try { await dl.save({ filename: nomeArquivo + '.html', data: html }); UI.toast('Arquivo salvo. Abra-o para imprimir ou salvar em PDF.'); Audit.registrar({ modulo: 'documentos', acao: 'emitiu', entidade: 'documento', entidadeId: nomeArquivo, rotulo: titulo, mudancas: [] }); }
      catch (e) { if (e.code !== 'declined') UI.toast('Não foi possível gerar o arquivo (' + (e.code || 'erro') + ').'); }
      return;
    }
    const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:0;height:0;border:0;'; document.body.appendChild(f);
    f.contentDocument.open(); f.contentDocument.write(html.replace(/<script>window\.addEventListener\('load'[\s\S]*?<\/script>/, '')); f.contentDocument.close();
    setTimeout(() => { f.contentWindow.print(); setTimeout(() => f.remove(), 2000); }, 600);
  },
  async baixarArquivo(nome, dados) {
    const dl = Cloud.caps.downloads;
    if (dl) { try { await dl.save({ filename: nome, data: dados }); return true; } catch (e) { if (e.code !== 'declined') UI.toast('Download não concluído (' + (e.code || 'erro') + ').'); return false; } }
    const url = URL.createObjectURL(dados instanceof Blob ? dados : new Blob([dados])); const a = document.createElement('a'); a.href = url; a.download = nome; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); return true;
  },
};

/** CPF: usuário do login (só dígitos) e senha inicial. */
const CPF = {
  limpar: s => String(s || '').replace(/\D/g, ''),
  formatar(s) { const d = CPF.limpar(s); return d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : String(s || ''); },
  mascarar(s) { const d = CPF.limpar(s); return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '—'; },
  valido(s) {
    const d = CPF.limpar(s); if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
    const dv = n => { let soma = 0; for (let i = 0; i < n; i++) soma += +d[i] * (n + 1 - i); const r = (soma * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === +d[9] && dv(10) === +d[10];
  },
};

/**
 * Senhas do login (frontend-only). SHA-256 com sal e 3.000 rodadas, em JavaScript puro (funciona também
 * em http:// na intranet, onde o navegador não libera o crypto.subtle). É controle organizacional: sem um
 * servidor, quem tem acesso aos dados do navegador consegue ler a tabela de usuários.
 */
const Senha = {
  RODADAS: 3000,
  sha256(msg) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const b = new TextEncoder().encode(msg), l = b.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n); m.set(b); m[l] = 0x80;
    const dv = new DataView(m.buffer); dv.setUint32(n - 4, l * 8); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
    let [h0, h1, h2, h3, h4, h5, h6, h7] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
      let a = h0, bb = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  },
  sal() { const a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a); return [...a].map(x => x.toString(16).padStart(2, '0')).join(''); },
  gerar(senha, sal = this.sal()) { let h = this.sha256(sal + ':' + senha); for (let i = 0; i < this.RODADAS; i++) h = this.sha256(h + sal); return { alg: 'sha256x' + this.RODADAS, sal, hash: h }; },
  confere(senha, reg) { return !!reg && !!reg.sal && this.gerar(senha, reg.sal).hash === reg.hash; },
  /** Senha forte: 8+ caracteres, letra maiúscula, minúscula e número, diferente do CPF. */
  problemas(senha, cpf = '') {
    const p = [];
    if (String(senha).length < 8) p.push('ter pelo menos 8 caracteres');
    if (!/[A-Z]/.test(senha)) p.push('ter uma letra maiúscula');
    if (!/[a-z]/.test(senha)) p.push('ter uma letra minúscula');
    if (!/\d/.test(senha)) p.push('ter um número');
    if (cpf && CPF.limpar(senha) === CPF.limpar(cpf)) p.push('ser diferente do CPF');
    return p;
  },
};

/**
 * Receita Federal: consulta de CNPJ. O provedor (BrasilAPI ou ReceitaWS) é ligado em
 * Configurações de Integração (nuvem.js → Integracoes.aplicar). Sem provedor, só valida os dígitos.
 */
const Receita = {
  provedor: null, // async cnpj(14 dígitos) => objeto no formato da BrasilAPI
  async consultar(cnpj) {
    const d = CNPJ.limpar(cnpj);
    if (!CNPJ.valido(d)) return { ok: false, motivo: 'CNPJ inválido (dígitos verificadores não conferem).' };
    if (!this.provedor) return { ok: false, motivo: 'CNPJ válido. A consulta automática está desligada em Configurações de Integração.' };
    let r; try { r = await this.provedor(d); } catch (e) { return { ok: false, motivo: e.message || 'Consulta indisponível no momento.' }; }
    const cep = String(r.cep || '').replace(/\D/g, '');
    return { ok: true, dados: { razaoSocial: r.razao_social, nomeFantasia: r.nome_fantasia, situacao: r.descricao_situacao_cadastral, endereco: [r.logradouro, r.numero, r.complemento, r.bairro].filter(Boolean).join(', '), cidade: r.municipio, uf: r.uf, cep: cep.length === 8 ? cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : cep, cnae: r.cnae_fiscal_descricao, abertura: r.data_inicio_atividade } };
  },
};

/* ============================== 7. UI ============================== */
const ICON = {
  pessoas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2c2.4.2 4.2 1.8 4.8 4.8"/></svg>',
  loja: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5 5.5 4h13L20 9.5"/><path d="M4 9.5c0 1.4 1.1 2.5 2.7 2.5s2.6-1.1 2.6-2.5c0 1.4 1.2 2.5 2.7 2.5s2.7-1.1 2.7-2.5c0 1.4 1 2.5 2.6 2.5S20 10.9 20 9.5"/><path d="M5.5 12v8h13v-8"/><path d="M10 20v-4.5h4V20"/></svg>',
  caixa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M4 19h16"/><path d="m7 14 3.5-4 3 2.5L19 7"/><path d="M15.5 7H19v3.5"/></svg>',
  diario: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><path d="m9 15 2 2 4-4"/></svg>',
  sair: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 5 6v5c0 4.4 3 8 7 10 4-2 7-5.6 7-10V6z"/><path d="M9.5 12h5M9.5 15h3M9.5 9h5"/></svg>',
  backup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/><path d="M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6"/></svg>',
  cadeado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/></svg>',
  retaguarda: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M3.5 10h17"/><path d="M7 14.5h4"/><path d="m15 14 1.5 1.5L19 13"/></svg>',
  whats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11.5a8 8 0 0 1-11.8 7L4 20l1.5-4A8 8 0 1 1 20 11.5z"/><path d="M9 9.5h6M9 13h4"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  fechar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  inicio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/></svg>',
  olho: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></svg>',
  olhoFechado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l16 16"/><path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.5M6.3 7.4C3.9 9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/><path d="M9.9 10a2.8 2.8 0 0 0 4 4"/></svg>',
  editar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  atualizar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/></svg>',
  contrato: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/></svg>',
  lixo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h4"/></svg>',
  ia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><path d="M12 7.5 13.4 10.6 16.5 12 13.4 13.4 12 16.5 10.6 13.4 7.5 12 10.6 10.6z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  alerta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>',
};

const UI = window.UI = {
  toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(this._t); this._t = setTimeout(() => t.classList.remove('show'), 3200); },
  /**
   * Modal genérico. acoes: [{rotulo, classe, acao(modalEl) → false p/ manter aberto, fechar}]
   */
  modal({ titulo, corpo, acoes = [{ rotulo: 'Fechar', classe: 'sec' }], largo = false, aoAbrir }) {
    const ov = document.createElement('div'); ov.className = 'overlay';
    ov.innerHTML = `<div class="modal ${largo ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
      <header><h3>${esc(titulo)}</h3><button class="iconbtn" data-x aria-label="Fechar">✕</button></header>
      <div class="body">${corpo}</div>
      <footer>${acoes.map((a, i) => `<button class="btn ${a.classe || ''}" data-i="${i}">${esc(a.rotulo)}</button>`).join('')}</footer></div>`;
    const fechar = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (!$('#modais').children.length) document.body.classList.remove('modal-aberto'); };
    const onKey = e => { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', async e => {
      if (e.target === ov || e.target.closest('[data-x]')) return fechar();
      const b = e.target.closest('footer [data-i]'); if (!b) return;
      const a = acoes[+b.dataset.i];
      if (a.acao) { b.disabled = true; try { const r = await a.acao(ov.querySelector('.modal')); if (r === false || a.fechar === false) { b.disabled = false; return; } } catch (err) { b.disabled = false; UI.toast(err.message || String(err)); return; } }
      fechar();
    });
    $('#modais').appendChild(ov);
    document.body.classList.add('modal-aberto');
    if (aoAbrir) aoAbrir(ov.querySelector('.modal'));
    UI.rotularTabelas(ov);
    const f = ov.querySelector('.body input, .body select, .body textarea'); if (f) f.focus();
    return { el: ov.querySelector('.modal'), fechar };
  },
  /**
   * Responsividade de tabelas: copia o título de cada coluna para o atributo
   * data-label das células. No celular (CSS @media ≤ 720px) cada linha vira um
   * cartão com "rótulo: valor", sem rolagem lateral. Tabelas .heat e .nolabel ficam de fora.
   */
  rotularTabelas(raiz = document) {
    $$('table:not(.heat):not(.nolabel)', raiz).forEach(t => {
      const ths = $$('thead th', t); if (!ths.length) return;
      const rot = ths.map(th => (th.dataset.label ?? th.textContent).replace(/\s+/g, ' ').trim());
      t.classList.add('resp');
      $$('tbody tr, tfoot tr', t).forEach(tr => [...tr.children].forEach((td, i) => { if (td.colSpan > 1) { td.classList.add('span-all'); return; } td.dataset.label = rot[i] || ''; }));
    });
  },
  confirmar(titulo, texto, rotuloOk = 'Confirmar', perigo = false) {
    return new Promise(ok => {
      let r = false;
      const m = UI.modal({ titulo, corpo: `<p style="margin:0">${texto}</p>`, acoes: [{ rotulo: 'Cancelar', classe: 'sec' }, { rotulo: rotuloOk, classe: perigo ? 'danger' : '', acao: () => { r = true; } }] });
      const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); ok(r); } });
      obs.observe($('#modais'), { childList: true });
    });
  },
  /** Lê os campos [name] de um formulário para um objeto (suporta "a.b.c", checkbox, number). */
  lerForm(el) {
    const o = {};
    $$('[name]', el).forEach(i => {
      let v;
      if (i.type === 'radio') { if (!i.checked) return; setPath(o, i.name, i.value); return; }
      if (i.type === 'checkbox') { if (i.dataset.lista) { if (!i.checked) return; const k = i.name; const cur = getPath(o, k) || []; cur.push(i.value); setPath(o, k, cur); return; } v = i.checked; }
      else if (i.type === 'number' || i.dataset.num) v = i.value === '' ? null : Number(String(i.value).replace(',', '.'));
      else v = i.value.trim();
      setPath(o, i.name, v);
    });
    return o;
  },
};
function getPath(o, p) { return p.split('.').reduce((a, k) => a == null ? a : a[k], o); }
function setPath(o, p, v) { const ks = p.split('.'); let c = o; ks.slice(0, -1).forEach(k => { c = c[k] ??= {}; }); c[ks.at(-1)] = v; return o; }
function mergeProfundo(base, extra) {
  const r = clone(base) || {};
  for (const [k, v] of Object.entries(extra || {})) r[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? mergeProfundo(r[k] || {}, v) : v;
  return r;
}
/** Campo de formulário padrão. */
function campo(rotulo, nome, valor, { tipo = 'text', opcoes, full, dica, attrs = '' } = {}) {
  const id = 'f_' + nome.replace(/\W/g, '_');
  let input;
  if (opcoes) input = `<select id="${id}" name="${nome}" ${attrs}>${opcoes.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(valor ?? '') ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
  else if (tipo === 'textarea') input = `<textarea id="${id}" name="${nome}" ${attrs}>${esc(valor ?? '')}</textarea>`;
  else input = `<input id="${id}" type="${tipo}" name="${nome}" value="${esc(valor ?? '')}" ${tipo === 'number' ? 'step="any"' : ''} ${attrs}>`;
  return `<div class="field ${full ? 'full' : ''}"><label class="lbl" for="${id}">${esc(rotulo)}</label>${input}${dica ? `<span class="hint" style="margin-top:4px">${dica}</span>` : ''}</div>`;
}
