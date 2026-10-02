/* =====================================================================
   RH — TABELAS DE DOMÍNIO (Cargos e Centros de Custo)
   Camada 6 (Serviços). A tela de Parametrizações fica em pessoal.js.
   Modelos:
     rh_cargos/<id>   { codigo, nome, status:'ativo'|'inativo', criadoEm, atualizadoEm, ... }
     rh_centros/<id>  { codigo, nome, status:'ativo'|'inativo', ... }
   Regras:
     • Exclusão é lógica (status 'inativo'): o histórico dos colaboradores continua apontando para o id.
     • Não há duplicidade: o código é único na tabela; a descrição é única em Cargos e, em Centros
       de Custo, única entre itens sem código (o plano repete nomes como "GESTÃO" sob códigos diferentes).
       Comparação sem acento e sem diferenciar maiúsculas.
     • Escrita somente pelo GESTOR (regra do banco: leitura "interact", escrita "admin").
   CSV de importação (cabeçalho exato): Categoria,Codigo,Descricao
     Categoria = "Cargo" ou "Centro de Custo"
   ===================================================================== */
const RH_TABELAS = {
  // nomeUnico: cargos nunca repetem a descrição; centros podem repetir (ex.: "GESTÃO") desde que o código seja outro
  cargos: { col: 'rh_cargos', rotulo: 'Cargos', singular: 'cargo', categoriaCSV: 'Cargo', prefixo: 'cg', nomeUnico: true },
  centros: { col: 'rh_centros', rotulo: 'Centros de Custo', singular: 'centro de custo', categoriaCSV: 'Centro de Custo', prefixo: 'cc', nomeUnico: false },
};
const RH_CSV_CABECALHO = ['Categoria', 'Codigo', 'Descricao'];

const RH = {
  chave: s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim(),
  /** Texto do CSV → tabela ('cargos' | 'centros') ou null. */
  tabelaDaCategoria(txt) {
    const k = this.chave(txt).replace(/S$/, '');
    if (['CARGO', 'FUNCAO', 'CARGO/FUNCAO'].includes(k)) return 'cargos';
    if (['CENTRO DE CUSTO', 'CENTRO DE CUSTOS', 'CENTRO', 'CC', 'CENTRO CUSTO'].includes(k) || k.startsWith('CENTRO DE CUST')) return 'centros';
    return null;
  },
  lista(tipo, { inativos = false } = {}) {
    return Repo.todos(RH_TABELAS[tipo].col).filter(x => inativos || x.status !== 'inativo')
      .sort((a, b) => (a.codigo || '').localeCompare(b.codigo || '', 'pt-BR', { numeric: true }) || a.nome.localeCompare(b.nome, 'pt-BR'));
  },
  ativos(tipo) { return this.lista(tipo); },
  get(tipo, id) { return id ? Repo.get(RH_TABELAS[tipo].col, id) : null; },
  rotulo(x) { return x ? (x.codigo ? `${x.codigo} – ${x.nome}` : x.nome) : ''; },
  /** Registro equivalente: mesmo código; ou mesma descrição (Cargos: sempre; Centros: só entre itens sem código). */
  encontrar(tipo, { codigo, nome }, ignorarId = null) {
    const t = RH_TABELAS[tipo], todos = Repo.todos(t.col).filter(x => x.id !== ignorarId);
    const kc = this.chave(codigo), kn = this.chave(nome);
    const porCodigo = kc && todos.find(x => this.chave(x.codigo) === kc);
    if (porCodigo) return porCodigo;
    if (!kn || (kc && !t.nomeUnico)) return null;
    return todos.find(x => this.chave(x.nome) === kn && (t.nomeUnico || !this.chave(x.codigo))) || null;
  },
  /** Quantos colaboradores (e metas de promoção do PDI) usam o item. */
  emUso(tipo, id) {
    const campo = tipo === 'cargos' ? 'cargoId' : 'centroCustoId';
    let n = Repo.todos('funcionarios').filter(f => f[campo] === id && (f.status || 'Ativo') !== 'Desligado').length;
    if (tipo === 'cargos') n += Repo.todos('pdi').reduce((a, p) => a + (p.avaliacoes || []).filter(av => av.cargoAlvoId === id).length, 0);
    return n;
  },

  /** Cria ou edita um item, validando duplicidade. Retorna o registro salvo. */
  async salvar(tipo, id, { codigo = '', nome, status = 'ativo' }) {
    const t = RH_TABELAS[tipo]; nome = String(nome || '').trim(); codigo = String(codigo || '').trim();
    if (!nome) throw new Error('Informe a descrição.');
    const dup = this.encontrar(tipo, { codigo, nome }, id);
    if (dup) throw new Error(`Já existe ${t.singular} com ${codigo && this.chave(dup.codigo) === this.chave(codigo) ? 'o código ' + codigo : 'essa descrição'}: ${this.rotulo(dup)}${dup.status === 'inativo' ? ' (inativo — reative-o em vez de criar outro)' : ''}.`);
    const rid = id || `${t.prefixo}-${uid()}`, antes = id ? this.get(tipo, id) : {};
    await Repo.salvar(t.col, rid, { ...antes, codigo, nome, status }, { modulo: 'pessoal', rotulo: `${t.rotulo}: ${this.rotulo({ codigo, nome })}` });
    return { id: rid, codigo, nome, status };
  },
  /** Soft delete / reativação. */
  async alterarStatus(tipo, id, status) {
    const t = RH_TABELAS[tipo], x = this.get(tipo, id);
    await Repo.salvar(t.col, id, { ...x, status }, { modulo: 'pessoal', rotulo: `${t.rotulo}: ${this.rotulo(x)}`, detalhe: status === 'inativo' ? 'Inativado' : 'Reativado' });
  },

  /** CSV modelo com o cabeçalho exato e duas linhas de exemplo. */
  modeloCSV() {
    return CSV.gerar([RH_CSV_CABECALHO, ['Cargo', 'VEN01', 'Vendedor(a)'], ['Centro de Custo', '2.05.014', '014 - SHOPPING TACARUNA I']]);
  },
  /**
   * Valida e prepara as linhas lidas do CSV (sem gravar). Regras:
   *  - categoria desconhecida ou descrição vazia → erro da linha;
   *  - repetida dentro do próprio arquivo → ignorada;
   *  - já existe (mesmo código; sem código, mesma descrição) → ignorada; se estiver inativa, é reativada;
   *  - mesmo código com descrição diferente → descrição atualizada.
   */
  analisarImportacao(linhas) {
    const plano = [], erros = [], vistos = new Set();
    linhas.forEach((l, i) => {
      const n = i + 2, tipo = this.tabelaDaCategoria(l.Categoria), codigo = String(l.Codigo ?? '').trim(), nome = String(l.Descricao ?? '').trim();
      if (!tipo) return erros.push(`Linha ${n}: categoria “${l.Categoria ?? ''}” inválida (use Cargo ou Centro de Custo).`);
      if (!nome) return erros.push(`Linha ${n}: descrição vazia.`);
      const chaves = [codigo && tipo + '|c:' + this.chave(codigo), (!codigo || RH_TABELAS[tipo].nomeUnico) && tipo + '|n:' + this.chave(nome)].filter(Boolean);
      if (chaves.some(k => vistos.has(k))) return plano.push({ n, tipo, codigo, nome, acao: 'repetida' });
      chaves.forEach(k => vistos.add(k));
      const ex = this.encontrar(tipo, { codigo, nome });
      if (!ex) return plano.push({ n, tipo, codigo, nome, acao: 'criar' });
      if (codigo && this.chave(ex.codigo) === this.chave(codigo) && this.chave(ex.nome) !== this.chave(nome)) {
        const outro = RH_TABELAS[tipo].nomeUnico && this.encontrar(tipo, { nome }, ex.id);
        if (outro) return erros.push(`Linha ${n}: a descrição “${nome}” já pertence a ${this.rotulo(outro)}.`);
        return plano.push({ n, tipo, codigo, nome, acao: 'atualizar', id: ex.id });
      }
      plano.push({ n, tipo, codigo, nome, acao: ex.status === 'inativo' ? 'reativar' : 'existente', id: ex.id });
    });
    return { plano, erros };
  },
  /** Grava o plano: um log de auditoria resumido para a importação inteira. */
  async importar(plano, nomeArquivo) {
    const r = { criar: 0, atualizar: 0, reativar: 0 }, mudancas = [];
    Sync.ocupado(true);
    try {
      for (const p of plano.filter(x => ['criar', 'atualizar', 'reativar'].includes(x.acao))) {
        const t = RH_TABELAS[p.tipo], id = p.id || `${t.prefixo}-${uid()}`, antes = p.id ? this.get(p.tipo, p.id) : {};
        const doc = p.acao === 'reativar' ? { ...antes, status: 'ativo' } : { ...antes, codigo: p.codigo || antes.codigo || '', nome: p.nome, status: 'ativo' };
        await Repo.salvar(t.col, id, doc, { modulo: 'pessoal', semAudit: true });
        r[p.acao]++; mudancas.push({ campo: `${t.categoriaCSV} ${p.acao === 'criar' ? 'criado' : p.acao === 'atualizar' ? 'atualizado' : 'reativado'}`, de: antes.nome || '', para: this.rotulo(doc) });
        await sleep(40);
      }
    } finally { Sync.ocupado(false); }
    await Audit.registrar({ modulo: 'pessoal', acao: 'importou', entidade: 'rh', entidadeId: nomeArquivo, rotulo: 'Parametrizações de RH · ' + nomeArquivo, detalhe: `${r.criar} criados, ${r.atualizar} atualizados, ${r.reativar} reativados`, mudancas: mudancas.slice(0, 60) });
    return r;
  },
};
