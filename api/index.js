const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const FRONTEND_DIR = path.join(__dirname, "../frontend");
app.use(express.static(FRONTEND_DIR));

// ======================================================
// BANCO DE DADOS (JSON)
// ======================================================

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "../backend/db.json");

const MEDICACOES_PADRAO = [
  "Dipirona", "Paracetamol", "Ibuprofeno", "Amoxicilina", "Azitromicina",
  "Loratadina", "Omeprazol", "Buscopan", "Dramin", "Soro fisiológico"
];

const TIPOS_USUARIO = ["admin", "triagem", "medico", "atendimento", "farmacia"];

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(senha), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

// Aceita senha com hash (scrypt$...) e senha antiga em texto puro
function confereSenha(senha, guardada) {
  if (typeof guardada !== "string") return false;
  if (guardada.startsWith("scrypt$")) {
    const [, salt, hash] = guardada.split("$");
    const teste = crypto.scryptSync(String(senha), salt, 64);
    const esperado = Buffer.from(hash, "hex");
    return esperado.length === teste.length && crypto.timingSafeEqual(esperado, teste);
  }
  return String(senha) === guardada;
}

function novoId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function criarDBInicial() {
  return {
    usuarios: [],
    almox_itens: [],
    almox_movimentos: [],
    almox_fornecedores: [],
    pacientes: [],
    triagens: [],
    consultas: [],
    medicacoes: [],
    auditoria: [],
    config: {},
    tv_chamada: null,
    tv_historico: []
  };
}

// Garante estrutura completa. Retorna true se algo foi alterado.
function normalizarDB(db) {
  let mudou = false;

  for (const k of ["usuarios", "pacientes", "triagens", "consultas", "medicacoes", "auditoria", "tv_historico", "almox_itens", "almox_movimentos", "almox_fornecedores", "agendamentos", "leitos", "financeiro", "equipe", "avisos", "contas", "exames"]) {
    if (!Array.isArray(db[k])) { db[k] = []; mudou = true; }
  }
  if (!("tv_chamada" in db)) { db.tv_chamada = null; mudou = true; }
  if (!db.config || typeof db.config !== "object") { db.config = {}; mudou = true; }

  if (!db.config.nomeSistema) { db.config.nomeSistema = "Projeto Sentinela"; mudou = true; }
  if (!db.config.tvHistoricoMax) { db.config.tvHistoricoMax = 5; mudou = true; }
  if (!db.config.secret) { db.config.secret = crypto.randomBytes(32).toString("hex"); mudou = true; }

  if (db.medicacoes.length === 0) {
    db.medicacoes = MEDICACOES_PADRAO.map((nome) => ({ id: novoId(), nome }));
    mudou = true;
  }

  // ids para usuários antigos + hash de senhas em texto puro
  for (const u of db.usuarios) {
    if (!u.id) { u.id = novoId(); mudou = true; }
    if (u.ativo === undefined) { u.ativo = true; mudou = true; }
    if (typeof u.senha === "string" && !u.senha.startsWith("scrypt$")) {
      u.senha = hashSenha(u.senha);
      mudou = true;
    }
  }

  // primeiro acesso: cria admin padrão se não existir nenhum
  if (!db.usuarios.some((u) => u.tipo === "admin")) {
    db.usuarios.push({
      id: novoId(),
      usuario: "admin",
      senha: hashSenha("admin123"),
      tipo: "admin",
      ativo: true
    });
    mudou = true;
  }

  return mudou;
}

function readDB() {
  let db;
  try {
    if (fs.existsSync(DB_FILE)) {
      const conteudo = fs.readFileSync(DB_FILE, "utf8").trim();
      db = conteudo ? JSON.parse(conteudo) : criarDBInicial();
    } else {
      db = criarDBInicial();
    }
  } catch (erro) {
    console.error("Erro ao ler banco de dados:", erro);
    db = criarDBInicial();
  }

  if (normalizarDB(db)) {
    try { writeDB(db); } catch (_) { /* sistema de arquivos somente leitura */ }
  }
  return db;
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}

// ======================================================
// STATUS / LOGIN GERAL
// ======================================================

app.get("/api/status", (req, res) => {
  res.json({ status: "online", mensagem: "API do Projeto Sentinela funcionando" });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.post("/login", (req, res) => {
  try {
    const db = readDB();
    const usuario = String(req.body.usuario || "").trim();
    const senha = String(req.body.senha || "").trim();

    const user = db.usuarios.find(
      (u) => u.usuario === usuario && u.ativo !== false && confereSenha(senha, u.senha)
    );

    if (!user) return res.status(401).json({ erro: "Login inválido" });

    // nunca devolve a senha
    const token = assinar({ id: user.id, usuario: user.usuario, exp: Date.now() + 12 * 60 * 60 * 1000 }, db.config.secret);
    res.json({ id: user.id, usuario: user.usuario, tipo: user.tipo, token });
  } catch (erro) {
    console.error("Erro no login:", erro);
    res.status(500).json({ erro: "Erro interno no servidor" });
  }
});

// ======================================================
// ATENDIMENTO / PACIENTES
// ======================================================

app.post("/atendimento", (req, res) => {
  try {
    const db = readDB();
    const paciente = {
      id: Date.now(),
      nome: req.body.nome,
      cpf: req.body.cpf,
      tipo: req.body.tipo,
      status: "triagem",
      createdAt: new Date().toISOString()
    };
    const cpfNum = soDigitos(paciente.cpf);
    const contaCpf = cpfNum && db.contas.find((c) => c.cpf === cpfNum);
    if (contaCpf) paciente.contaId = contaCpf.id;
    paciente.senha = proximaSenha(db);
    db.pacientes.push(paciente);
    writeDB(db);
    res.json(paciente);
  } catch (erro) {
    console.error("Erro no atendimento:", erro);
    res.status(500).json({ erro: "Erro ao cadastrar paciente" });
  }
});

app.get("/pacientes", (req, res) => {
  try {
    res.json(readDB().pacientes);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao listar pacientes" });
  }
});

// ======================================================
// TRIAGEM
// ======================================================

app.post("/triagem", (req, res) => {
  try {
    const db = readDB();
    let risco = req.body.risco;
    const temperatura = Number(req.body.temperatura);

    if (temperatura >= 39) risco = "vermelho";
    else if (temperatura >= 38) risco = "amarelo";
    else if (!risco) risco = "verde";

    const triagem = {
      id: Date.now(),
      nome: req.body.nome,
      sintoma: req.body.sintoma,
      temperatura,
      alergia: req.body.alergia,
      observacao: req.body.observacao,
      risco,
      status: "aguardando_medico",
      createdAt: new Date().toISOString()
    };
    const alvoT = ultimoPacienteAberto(db, triagem.nome, ["triagem"]);
    if (alvoT) {
      triagem.pacienteId = alvoT.id;
      if (alvoT.contaId) triagem.contaId = alvoT.contaId;
      alvoT.status = "em_atendimento";
    }
    db.triagens.push(triagem);
    writeDB(db);
    res.json(triagem);
  } catch (erro) {
    console.error("Erro na triagem:", erro);
    res.status(500).json({ erro: "Erro ao realizar triagem" });
  }
});

app.get("/triagens", (req, res) => {
  try {
    res.json(readDB().triagens);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao listar triagens" });
  }
});

// ======================================================
// TV
// ======================================================

app.post("/tv/chamar", (req, res) => {
  try {
    const db = readDB();
    const chamada = {
      id: Date.now().toString(),
      localTipo: req.body.localTipo,
      localNumero: req.body.localNumero,
      paciente: req.body.paciente,
      hora: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    };
    db.tv_chamada = chamada;
    db.tv_historico.unshift(chamada);
    db.tv_historico = db.tv_historico.slice(0, Number(db.config.tvHistoricoMax) || 5);
    writeDB(db);
    res.json(chamada);
  } catch (erro) {
    console.error("Erro ao chamar paciente:", erro);
    res.status(500).json({ erro: "Erro ao realizar chamada" });
  }
});

app.get("/tv/chamada", (req, res) => {
  try {
    const db = readDB();
    res.json({ chamada: db.tv_chamada, historico: db.tv_historico });
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao consultar chamada" });
  }
});

app.get("/avisos-ativos", (req, res) => {
  const peso = { urgente: 0, importante: 1, normal: 2 };
  const lista = readDB().avisos
    .filter((a) => a.ativo !== false)
    .sort((a, b) => (peso[a.prioridade] ?? 2) - (peso[b.prioridade] ?? 2))
    .map((a) => ({ titulo: a.titulo, mensagem: a.mensagem, prioridade: a.prioridade }));
  res.json(lista);
});

// ======================================================
// MEDICAÇÕES E CONSULTAS
// ======================================================

app.get("/lista-medicacoes", (req, res) => {
  try {
    res.json(readDB().medicacoes.map((m) => m.nome));
  } catch (erro) {
    res.json(MEDICACOES_PADRAO);
  }
});

app.post("/consulta", (req, res) => {
  try {
    const db = readDB();
    const consulta = {
      id: Date.now(),
      paciente: req.body.paciente,
      diagnostico: req.body.diagnostico,
      medicacao: req.body.medicacao,
      obs: req.body.obs,
      createdAt: new Date().toISOString()
    };
    const alvoC = ultimoPacienteAberto(db, consulta.paciente, ["triagem", "em_atendimento"]);
    if (alvoC) {
      consulta.pacienteId = alvoC.id;
      if (alvoC.contaId) consulta.contaId = alvoC.contaId;
      alvoC.status = "atendido";
      alvoC.atendidoEm = consulta.createdAt;
    } else {
      const cid = vincularConta(db, consulta.paciente);
      if (cid) consulta.contaId = cid;
    }
    const nomeC = String(consulta.paciente || "").trim().toLowerCase();
    db.triagens.filter((t) => String(t.nome || "").trim().toLowerCase() === nomeC && (!t.status || t.status === "aguardando_medico"))
      .forEach((t) => { t.status = "atendido"; });
    db.consultas.push(consulta);
    writeDB(db);
    res.json(consulta);
  } catch (erro) {
    console.error("Erro ao salvar consulta:", erro);
    res.status(500).json({ erro: "Erro ao salvar consulta" });
  }
});

app.get("/medicacoes", (req, res) => {
  try {
    res.json(readDB().consultas);
  } catch (erro) {
    res.status(500).json({ erro: "Erro ao listar medicações" });
  }
});

// ======================================================
// ======================  ADMIN  =======================
// ======================================================

const admin = express.Router();

// ---------- token assinado (HMAC) ----------

function assinar(payload, secret) {
  const corpo = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(corpo).digest("base64url");
  return `${corpo}.${sig}`;
}

function verificar(token, secret) {
  if (!token || typeof token !== "string") return null;
  const [corpo, sig] = token.split(".");
  if (!corpo || !sig) return null;
  const esperado = crypto.createHmac("sha256", secret).update(corpo).digest("base64url");
  if (sig.length !== esperado.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  try {
    const p = JSON.parse(Buffer.from(corpo, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch (_) {
    return null;
  }
}

// ---------- limite de tentativas de login ----------

const tentativas = new Map();
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 60 * 1000;

function bloqueado(ip) {
  const t = tentativas.get(ip);
  return !!t && t.bloqueadoAte > Date.now();
}
function falhou(ip) {
  const t = tentativas.get(ip) || { n: 0, bloqueadoAte: 0 };
  t.n += 1;
  if (t.n >= MAX_TENTATIVAS) { t.bloqueadoAte = Date.now() + BLOQUEIO_MS; t.n = 0; }
  tentativas.set(ip, t);
}

// ---------- auditoria ----------

function auditar(db, req, acao, detalhe) {
  db.auditoria.unshift({
    id: novoId(),
    data: new Date().toISOString(),
    usuario: req.admin ? req.admin.usuario : "—",
    acao,
    detalhe: detalhe || ""
  });
  db.auditoria = db.auditoria.slice(0, 1000);
}

// ---------- login do admin ----------

admin.post("/login", (req, res) => {
  const ip = req.ip;
  if (bloqueado(ip)) {
    return res.status(429).json({ erro: "Muitas tentativas. Aguarde 1 minuto." });
  }

  const db = readDB();
  const usuario = String(req.body.usuario || "").trim();
  const senha = String(req.body.senha || "");

  const user = db.usuarios.find(
    (u) => u.usuario === usuario && u.tipo === "admin" && u.ativo !== false && confereSenha(senha, u.senha)
  );

  if (!user) {
    falhou(ip);
    return res.status(401).json({ erro: "Usuário ou senha de administrador inválidos" });
  }

  tentativas.delete(ip);
  const token = assinar(
    { id: user.id, usuario: user.usuario, exp: Date.now() + 8 * 60 * 60 * 1000 },
    db.config.secret
  );

  req.admin = user;
  auditar(db, req, "login", "Login no painel admin");
  try { writeDB(db); } catch (_) {}

  res.json({ token, usuario: user.usuario });
});

// ---------- proteção de todas as rotas abaixo ----------

admin.use((req, res, next) => {
  const db = readDB();
  const payload = verificar(req.headers["x-admin-token"], db.config.secret);
  const user = payload && db.usuarios.find((u) => u.id === payload.id);

  if (!user || user.tipo !== "admin" || user.ativo === false) {
    return res.status(401).json({ erro: "Sessão expirada ou não autorizada" });
  }

  req.db = db;
  req.admin = user;
  next();
});

function salvar(req) {
  writeDB(req.db);
}

// rotas de dados reutilizadas pelo painel admin e pelo portal da equipe
const crud = express.Router();

// ---------- resumo (dashboard) ----------

admin.get("/resumo", (req, res) => {
  const db = req.db;
  const contar = (arr, campo) =>
    arr.reduce((acc, x) => { const v = x[campo] || "—"; acc[v] = (acc[v] || 0) + 1; return acc; }, {});

  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dias.push(d.toISOString().slice(0, 10));
  }
  const porDia = (arr) =>
    dias.map((dia) => ({ dia, total: arr.filter((x) => (x.createdAt || "").slice(0, 10) === dia).length }));

  res.json({
    totais: {
      pacientes: db.pacientes.length,
      triagens: db.triagens.length,
      consultas: db.consultas.length,
      usuarios: db.usuarios.length,
      medicacoes: db.medicacoes.length
    },
    risco: contar(db.triagens, "risco"),
    statusPacientes: contar(db.pacientes, "status"),
    tiposUsuario: contar(db.usuarios, "tipo"),
    pacientesPorDia: porDia(db.pacientes),
    triagensPorDia: porDia(db.triagens),
    consultasPorDia: porDia(db.consultas),
    tv: { chamada: db.tv_chamada, historico: db.tv_historico },
    ultimasAcoes: db.auditoria.slice(0, 8)
  });
});

// ---------- CRUD genérico das coleções ----------

const rotulo = (i) => i.nome || i.usuario || i.paciente || i.titulo || i.descricao || i.numero || String(i.id);
const txt = (v) => (v === undefined || v === null ? "" : String(v).trim());
const em = (lista) => (v) => (lista.includes(txt(v)) ? txt(v) : null);

const num = (v) => Math.max(0, Math.round((Number(v) || 0) * 1000) / 1000);

const SCHEMAS = {
  contas: {
    campos: { nome: txt, telefone: txt, email: txt, convenio: txt, nascimento: txt, ativo: (v) => v === true || v === "true" },
    obrigatorios: ["nome"],
    padrao: { ativo: true }
  },
  exames: {
    campos: { paciente: txt, exame: txt, solicitante: txt, obs: txt, resultado: txt,
      status: em(["solicitado", "coletado", "pronto"]) },
    obrigatorios: ["paciente", "exame"],
    padrao: { status: "solicitado" }
  },
  agendamentos: {
    campos: { paciente: txt, medico: txt, data: txt, hora: txt, tipo: txt, obs: txt,
      status: em(["agendado", "confirmado", "realizado", "cancelado"]) },
    obrigatorios: ["paciente", "data"],
    padrao: { status: "agendado" }
  },
  leitos: {
    campos: { numero: txt, setor: txt, paciente: txt, status: em(["livre", "ocupado", "limpeza", "manutencao"]) },
    obrigatorios: ["numero"],
    padrao: { status: "livre", setor: "Enfermaria" }
  },
  financeiro: {
    campos: { descricao: txt, categoria: txt, valor: num, data: txt,
      tipo: em(["receita", "despesa"]), status: em(["pago", "pendente"]) },
    obrigatorios: ["descricao", "tipo"],
    padrao: { status: "pendente", valor: 0 }
  },
  equipe: {
    campos: { nome: txt, cargo: txt, setor: txt, turno: txt, telefone: txt },
    obrigatorios: ["nome"],
    padrao: {}
  },
  avisos: {
    campos: { titulo: txt, mensagem: txt, prioridade: em(["normal", "importante", "urgente"]),
      ativo: (v) => v === true || v === "true" },
    obrigatorios: ["titulo"],
    padrao: { prioridade: "normal", ativo: true }
  },
  almox_itens: {
    campos: { nome: txt, categoria: txt, unidade: txt, minimo: num, localizacao: txt, lote: txt, validade: txt, fornecedor: txt },
    obrigatorios: ["nome"],
    padrao: { unidade: "un", minimo: 0 }
  },
  almox_fornecedores: {
    campos: { nome: txt, cnpj: txt, contato: txt, telefone: txt, email: txt },
    obrigatorios: ["nome"],
    padrao: {}
  },
  pacientes: {
    campos: { nome: txt, cpf: txt, tipo: txt, status: txt },
    obrigatorios: ["nome"],
    padrao: { status: "triagem" }
  },
  triagens: {
    campos: {
      nome: txt, sintoma: txt,
      temperatura: (v) => (v === "" || v === null || v === undefined ? 0 : Number(v)),
      alergia: txt, observacao: txt,
      risco: em(["verde", "amarelo", "vermelho"]),
      status: txt
    },
    obrigatorios: ["nome"],
    padrao: { risco: "verde", status: "aguardando_medico" }
  },
  consultas: {
    campos: { paciente: txt, diagnostico: txt, medicacao: txt, obs: txt },
    obrigatorios: ["paciente"],
    padrao: {}
  },
  medicacoes: {
    campos: { nome: txt },
    obrigatorios: ["nome"],
    padrao: {}
  },
  usuarios: {
    campos: { usuario: txt, tipo: em(TIPOS_USUARIO), ativo: (v) => v === true || v === "true" },
    obrigatorios: ["usuario", "tipo"],
    padrao: { ativo: true }
  }
};

function colecaoValida(req, res, next) {
  const col = req.params.col;
  if (!SCHEMAS[col] && col !== "auditoria" && col !== "almox_movimentos") {
    return res.status(404).json({ erro: "Coleção inválida" });
  }
  next();
}

function publico(col, item) {
  if (col === "usuarios" || col === "contas") {
    const { senha, ...resto } = item;
    return resto;
  }
  return item;
}

function adminsAtivos(db, ignorarId) {
  return db.usuarios.filter((u) => u.tipo === "admin" && u.ativo !== false && String(u.id) !== String(ignorarId));
}

crud.get("/colecao/:col", colecaoValida, (req, res) => {
  const col = req.params.col;
  const lista = req.db[col].map((x) => publico(col, x));
  res.json(col === "auditoria" ? lista : [...lista].reverse());
});

crud.post("/colecao/:col", colecaoValida, (req, res) => {
  const col = req.params.col;
  const schema = SCHEMAS[col];
  if (!schema || col === "contas") return res.status(405).json({ erro: "Esta coleção não permite criação manual" });

  const item = { id: novoId(), ...schema.padrao };
  for (const [campo, fn] of Object.entries(schema.campos)) {
    if (req.body[campo] !== undefined) item[campo] = fn(req.body[campo]);
  }
  const invalido = Object.keys(item).find((k) => item[k] === null);
  if (invalido) return res.status(400).json({ erro: `Valor inválido para o campo: ${invalido}` });
  for (const campo of schema.obrigatorios) {
    if (item[campo] === null || item[campo] === undefined || item[campo] === "") {
      return res.status(400).json({ erro: `Campo obrigatório inválido: ${campo}` });
    }
  }

  if (col === "usuarios") {
    const senha = String(req.body.senha || "");
    if (senha.length < 4) return res.status(400).json({ erro: "Senha precisa ter ao menos 4 caracteres" });
    if (req.db.usuarios.some((u) => u.usuario === item.usuario)) {
      return res.status(409).json({ erro: "Já existe um usuário com esse nome" });
    }
    item.senha = hashSenha(senha);
  }

  item.createdAt = new Date().toISOString();

  if (col === "almox_itens") {
    const inicial = num(req.body.estoque);
    item.estoque = inicial;
    if (inicial > 0) {
      req.db.almox_movimentos.push({
        id: novoId(), itemId: item.id, itemNome: item.nome, unidade: item.unidade,
        tipo: "entrada", quantidade: inicial, saldoAnterior: 0, saldoApos: inicial,
        motivo: "Estoque inicial", usuario: req.admin.usuario, createdAt: item.createdAt
      });
    }
  }

  if (col === "agendamentos" || col === "exames") {
    const cid = vincularConta(req.db, item.paciente);
    if (cid) item.contaId = cid;
  }
  req.db[col].push(item);
  auditar(req.db, req, `criar ${col}`, rotulo(item));
  salvar(req);
  res.json(publico(col, item));
});

crud.put("/colecao/:col/:id", colecaoValida, (req, res) => {
  const col = req.params.col;
  const schema = SCHEMAS[col];
  if (!schema) return res.status(405).json({ erro: "Esta coleção não permite edição" });

  const item = req.db[col].find((x) => String(x.id) === req.params.id);
  if (!item) return res.status(404).json({ erro: "Registro não encontrado" });

  const novo = {};
  for (const [campo, fn] of Object.entries(schema.campos)) {
    if (req.body[campo] !== undefined) novo[campo] = fn(req.body[campo]);
  }
  const invalidoPut = Object.keys(novo).find((k) => novo[k] === null);
  if (invalidoPut) return res.status(400).json({ erro: `Valor inválido para o campo: ${invalidoPut}` });
  for (const campo of Object.keys(novo)) {
    if (schema.obrigatorios.includes(campo) && (novo[campo] === null || novo[campo] === "")) {
      return res.status(400).json({ erro: `Campo obrigatório inválido: ${campo}` });
    }
  }

  if (col === "usuarios") {
    if (novo.usuario && req.db.usuarios.some((u) => u.usuario === novo.usuario && u.id !== item.id)) {
      return res.status(409).json({ erro: "Já existe um usuário com esse nome" });
    }
    const deixaDeSerAdminAtivo =
      item.tipo === "admin" && item.ativo !== false &&
      ((novo.tipo && novo.tipo !== "admin") || novo.ativo === false);
    if (deixaDeSerAdminAtivo && adminsAtivos(req.db, item.id).length === 0) {
      return res.status(400).json({ erro: "Não é possível remover/desativar o único administrador ativo" });
    }
    if (req.body.senha) {
      if (String(req.body.senha).length < 4) {
        return res.status(400).json({ erro: "Senha precisa ter ao menos 4 caracteres" });
      }
      novo.senha = hashSenha(req.body.senha);
    }
  }

  if (col === "contas" && req.body.senha) {
    if (String(req.body.senha).length < 6) return res.status(400).json({ erro: "A senha precisa ter ao menos 6 caracteres" });
    novo.senha = hashSenha(req.body.senha);
  }
  if (col === "contas" && novo.email) {
    novo.email = novo.email.toLowerCase();
    if (req.db.contas.some((c) => c.email === novo.email && c.id !== item.id)) return res.status(409).json({ erro: "Este e-mail já está em uso por outra conta" });
  }

  Object.assign(item, novo, { updatedAt: new Date().toISOString() });
  auditar(req.db, req, `editar ${col}`, rotulo(item));
  salvar(req);
  res.json(publico(col, item));
});

crud.delete("/colecao/:col/:id", colecaoValida, (req, res) => {
  const col = req.params.col;
  if (col === "almox_movimentos") {
    return res.status(400).json({ erro: "Movimentações não podem ser excluídas individualmente (use um ajuste de estoque)" });
  }
  const lista = req.db[col];
  const idx = lista.findIndex((x) => String(x.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: "Registro não encontrado" });

  const item = lista[idx];
  if (col === "usuarios") {
    if (item.id === req.admin.id) {
      return res.status(400).json({ erro: "Você não pode excluir o próprio usuário" });
    }
    if (item.tipo === "admin" && item.ativo !== false && adminsAtivos(req.db, item.id).length === 0) {
      return res.status(400).json({ erro: "Não é possível excluir o único administrador ativo" });
    }
  }

  lista.splice(idx, 1);
  auditar(req.db, req, `excluir ${col}`, rotulo(item));
  salvar(req);
  res.json({ ok: true });
});

// apagar todos os registros de uma coleção (exceto usuários)
admin.post("/colecao/:col/limpar", colecaoValida, (req, res) => {
  const col = req.params.col;
  if (col === "usuarios") {
    return res.status(400).json({ erro: "Usuários não podem ser apagados em massa" });
  }
  if (req.body.confirmar !== "CONFIRMAR") {
    return res.status(400).json({ erro: "Confirmação ausente" });
  }
  const qtd = req.db[col].length;
  req.db[col] = [];
  auditar(req.db, req, `limpar ${col}`, `${qtd} registros removidos`);
  if (col === "medicacoes") normalizarDB(req.db); // recoloca a lista padrão
  salvar(req);
  res.json({ ok: true, removidos: qtd });
});

// ---------- TV ----------

admin.get("/tv", (req, res) => {
  res.json({ chamada: req.db.tv_chamada, historico: req.db.tv_historico });
});

admin.post("/tv/chamar", (req, res) => {
  const paciente = txt(req.body.paciente);
  if (!paciente) return res.status(400).json({ erro: "Informe o paciente" });

  const chamada = {
    id: Date.now().toString(),
    localTipo: txt(req.body.localTipo) || "GUICHÊ",
    localNumero: txt(req.body.localNumero) || "01",
    paciente,
    hora: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
  };
  req.db.tv_chamada = chamada;
  req.db.tv_historico.unshift(chamada);
  req.db.tv_historico = req.db.tv_historico.slice(0, Number(req.db.config.tvHistoricoMax) || 5);
  auditar(req.db, req, "chamar na TV", `${paciente} → ${chamada.localTipo} ${chamada.localNumero}`);
  salvar(req);
  res.json(chamada);
});

admin.post("/tv/limpar-chamada", (req, res) => {
  req.db.tv_chamada = null;
  auditar(req.db, req, "limpar chamada da TV");
  salvar(req);
  res.json({ ok: true });
});

admin.post("/tv/limpar-historico", (req, res) => {
  req.db.tv_historico = [];
  req.db.tv_chamada = null;
  auditar(req.db, req, "limpar histórico da TV");
  salvar(req);
  res.json({ ok: true });
});

admin.delete("/tv/historico/:id", (req, res) => {
  req.db.tv_historico = req.db.tv_historico.filter((c) => c.id !== req.params.id);
  auditar(req.db, req, "remover item do histórico da TV", req.params.id);
  salvar(req);
  res.json({ ok: true });
});

// ---------- configurações ----------

admin.get("/config", (req, res) => {
  const { secret, ...cfg } = req.db.config;
  res.json(cfg);
});

admin.put("/config", (req, res) => {
  const nome = txt(req.body.nomeSistema);
  const max = Number(req.body.tvHistoricoMax);
  if (!nome) return res.status(400).json({ erro: "Informe o nome do sistema" });
  if (!Number.isInteger(max) || max < 1 || max > 50) {
    return res.status(400).json({ erro: "Histórico da TV deve ser entre 1 e 50" });
  }
  req.db.config.nomeSistema = nome;
  req.db.config.tvHistoricoMax = max;
  req.db.tv_historico = req.db.tv_historico.slice(0, max);
  auditar(req.db, req, "alterar configurações", `nome=${nome}, histórico TV=${max}`);
  salvar(req);
  res.json({ ok: true });
});

// ---------- banco de dados: backup / restauração / reset ----------

admin.get("/backup", (req, res) => {
  const copia = JSON.parse(JSON.stringify(req.db));
  delete copia.config.secret;
  auditar(req.db, req, "backup", "Backup baixado");
  salvar(req);
  const nome = `sentinela-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
  res.json(copia);
});

admin.post("/restaurar", (req, res) => {
  const dados = req.body && req.body.dados;
  if (req.body.confirmar !== "CONFIRMAR") {
    return res.status(400).json({ erro: "Confirmação ausente" });
  }
  if (!dados || typeof dados !== "object" || !Array.isArray(dados.usuarios)) {
    return res.status(400).json({ erro: "Arquivo de backup inválido" });
  }
  if (!dados.usuarios.some((u) => u.tipo === "admin" && u.ativo !== false)) {
    return res.status(400).json({ erro: "O backup não contém nenhum administrador ativo" });
  }

  const novo = { ...criarDBInicial(), ...dados };
  novo.config = { ...(dados.config || {}), secret: req.db.config.secret };
  normalizarDB(novo);
  req.db = novo;
  auditar(req.db, req, "restaurar backup", "Banco restaurado a partir de arquivo");
  salvar(req);
  res.json({ ok: true });
});

admin.post("/resetar", (req, res) => {
  if (req.body.confirmar !== "RESETAR") {
    return res.status(400).json({ erro: "Digite RESETAR para confirmar" });
  }
  req.db.pacientes = [];
  req.db.triagens = [];
  req.db.consultas = [];
  req.db.tv_chamada = null;
  req.db.tv_historico = [];
  auditar(req.db, req, "resetar dados operacionais", "Pacientes, triagens, consultas e TV apagados");
  salvar(req);
  res.json({ ok: true });
});

// ---------- almoxarifado ----------

function situacaoItem(i) {
  const hoje = new Date().toISOString().slice(0, 10);
  const limite = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  if (i.validade && i.validade < hoje) return "vencido";
  if ((i.estoque || 0) <= 0) return "sem_estoque";
  if (i.minimo > 0 && i.estoque <= i.minimo) return "baixo";
  if (i.validade && i.validade <= limite) return "vence_breve";
  return "ok";
}

crud.post("/almox/movimentar", (req, res) => {
  const item = req.db.almox_itens.find((i) => String(i.id) === String(req.body.itemId));
  if (!item) return res.status(404).json({ erro: "Item não encontrado" });

  const tipo = txt(req.body.tipo);
  if (!["entrada", "saida", "ajuste"].includes(tipo)) return res.status(400).json({ erro: "Tipo de movimentação inválido" });

  if (req.body.quantidade === "" || req.body.quantidade === undefined || req.body.quantidade === null) {
    return res.status(400).json({ erro: "Informe a quantidade" });
  }
  const q = Math.round(Number(req.body.quantidade) * 1000) / 1000;
  if (!isFinite(q) || q < 0 || (tipo !== "ajuste" && q <= 0)) {
    return res.status(400).json({ erro: "Quantidade inválida" });
  }

  const anterior = item.estoque || 0;
  let novo;
  if (tipo === "entrada") novo = anterior + q;
  else if (tipo === "saida") {
    if (q > anterior) return res.status(400).json({ erro: `Estoque insuficiente (saldo atual: ${anterior} ${item.unidade})` });
    novo = anterior - q;
  } else novo = q;
  novo = Math.round(novo * 1000) / 1000;

  const mov = {
    id: novoId(), itemId: item.id, itemNome: item.nome, unidade: item.unidade,
    tipo, quantidade: q, saldoAnterior: anterior, saldoApos: novo,
    motivo: txt(req.body.motivo), usuario: req.admin.usuario, createdAt: new Date().toISOString()
  };
  item.estoque = novo;
  req.db.almox_movimentos.push(mov);
  auditar(req.db, req, `almoxarifado: ${tipo}`, `${item.nome}: ${anterior} → ${novo} ${item.unidade}`);
  salvar(req);
  res.json({ item, mov });
});

crud.get("/almox/resumo", (req, res) => {
  const itens = req.db.almox_itens;
  const movs = req.db.almox_movimentos;
  const resumoItem = (i) => ({ id: i.id, nome: i.nome, estoque: i.estoque || 0, unidade: i.unidade, minimo: i.minimo, validade: i.validade });
  const grupo = (sit) => itens.filter((i) => situacaoItem(i) === sit).map(resumoItem);

  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dias.push(d.toISOString().slice(0, 10));
  }
  const porDia = (tipo) => dias.map((dia) => ({
    dia,
    total: movs.filter((m) => m.tipo === tipo && (m.createdAt || "").slice(0, 10) === dia).length
  }));

  const corte = Date.now() - 30 * 86400000;
  const saidas = {};
  for (const m of movs) {
    if (m.tipo === "saida" && new Date(m.createdAt).getTime() >= corte) {
      saidas[m.itemNome] = (saidas[m.itemNome] || 0) + m.quantidade;
    }
  }
  const topSaidas = Object.entries(saidas).sort((a, b) => b[1] - a[1]).slice(0, 5);

  res.json({
    totais: { itens: itens.length, fornecedores: req.db.almox_fornecedores.length, movimentacoes: movs.length },
    alertas: { vencidos: grupo("vencido"), semEstoque: grupo("sem_estoque"), baixo: grupo("baixo"), venceBreve: grupo("vence_breve") },
    entradasPorDia: porDia("entrada"),
    saidasPorDia: porDia("saida"),
    topSaidas
  });
});

admin.use(crud);

// ======================================================
// ================  PORTAL DO PACIENTE  ================
// ======================================================

const BR = () => new Date(Date.now() - 3 * 3600 * 1000); // horário de Brasília
const hojeBR = () => BR().toISOString().slice(0, 10);
const diaBR = (iso) => new Date(new Date(iso).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const soDigitos = (v) => String(v || "").replace(/\D/g, "");
const fmtCPF = (c) => String(c).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
const nomeIgual = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

function cpfValido(c) {
  c = soDigitos(c);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(c[t])) return false;
  }
  return true;
}

// só vincula quando existe exatamente uma conta com esse nome (evita confundir homônimos)
function vincularConta(db, nome) {
  const lista = db.contas.filter((c) => c.ativo !== false && nomeIgual(c.nome, nome));
  return lista.length === 1 ? lista[0].id : undefined;
}
function ultimoPacienteAberto(db, nome, status) {
  return db.pacientes.filter((p) => nomeIgual(p.nome, nome) && status.includes(p.status))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop();
}
function proximaSenha(db) {
  const n = db.pacientes.filter((p) => p.createdAt && diaBR(p.createdAt) === hojeBR()).length + 1;
  return "A" + String(n).padStart(3, "0");
}

const janelas = new Map();
const registrar = (k) => { const a = janelas.get(k) || []; a.push(Date.now()); janelas.set(k, a); };
const contagem = (k, ms) => { const a = (janelas.get(k) || []).filter((t) => Date.now() - t < ms); janelas.set(k, a); return a.length; };

const pac = express.Router();
const publicoConta = (c) => { const { senha, ...r } = c; return r; };
const tokenConta = (db, c) => assinar({ pid: c.id, exp: Date.now() + 12 * 3600 * 1000 }, db.config.secret);

pac.post("/cadastro", (req, res) => {
  const chave = "cad:" + req.ip;
  if (contagem(chave, 3600 * 1000) >= 10) return res.status(429).json({ erro: "Muitos cadastros deste dispositivo. Tente mais tarde." });
  const db = readDB(), b = req.body || {};
  const nome = txt(b.nome), email = txt(b.email).toLowerCase(), cpf = soDigitos(b.cpf), senha = String(b.senha || "");
  const nasc = txt(b.nascimento);

  if (nome.length < 3) return res.status(400).json({ erro: "Informe seu nome completo" });
  if (!cpfValido(cpf)) return res.status(400).json({ erro: "CPF inválido" });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ erro: "E-mail inválido" });
  if (nasc && (isNaN(new Date(nasc)) || nasc > hojeBR())) return res.status(400).json({ erro: "Data de nascimento inválida" });
  if (senha.length < 6) return res.status(400).json({ erro: "A senha precisa ter ao menos 6 caracteres" });
  if (b.consentimento !== true) return res.status(400).json({ erro: "É necessário aceitar os termos de uso e privacidade (LGPD)" });
  if (db.contas.some((c) => c.cpf === cpf)) return res.status(409).json({ erro: "Já existe uma conta com este CPF. Tente entrar." });
  if (db.contas.some((c) => c.email === email)) return res.status(409).json({ erro: "Já existe uma conta com este e-mail." });

  const agora = new Date().toISOString();
  const conta = {
    id: novoId(), nome, cpf, email, nascimento: nasc, telefone: txt(b.telefone),
    convenio: txt(b.convenio) || "Particular", carteirinha: txt(b.carteirinha),
    ativo: true, senha: hashSenha(senha), consentimento: true, consentimentoEm: agora, createdAt: agora
  };
  db.contas.push(conta);
  writeDB(db);
  registrar(chave);
  res.json({ token: tokenConta(db, conta), conta: publicoConta(conta) });
});

pac.post("/login", (req, res) => {
  const chave = "login:" + req.ip;
  if (contagem(chave, 5 * 60 * 1000) >= 8) return res.status(429).json({ erro: "Muitas tentativas. Aguarde alguns minutos." });
  const db = readDB();
  const id = txt(req.body.login), senha = String(req.body.senha || "");
  const cpf = soDigitos(id);
  const conta = db.contas.find((c) => (c.email === id.toLowerCase() || (cpf.length === 11 && c.cpf === cpf)) && c.ativo !== false);
  if (!conta || !confereSenha(senha, conta.senha)) {
    registrar(chave);
    return res.status(401).json({ erro: "CPF/e-mail ou senha incorretos" });
  }
  res.json({ token: tokenConta(db, conta), conta: publicoConta(conta) });
});

// ---- tudo abaixo exige login do paciente ----
pac.use((req, res, next) => {
  const db = readDB();
  const p = verificar(req.headers["x-token"], db.config.secret);
  const conta = p && p.pid && db.contas.find((c) => c.id === p.pid);
  if (!conta || conta.ativo === false) return res.status(401).json({ erro: "Sessão expirada. Entre novamente." });
  req.db = db;
  req.conta = conta;
  next();
});

pac.get("/eu", (req, res) => res.json(publicoConta(req.conta)));

pac.put("/eu", (req, res) => {
  const c = req.conta, b = req.body || {};
  if (b.email !== undefined) {
    const email = txt(b.email).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ erro: "E-mail inválido" });
    if (req.db.contas.some((x) => x.email === email && x.id !== c.id)) return res.status(409).json({ erro: "Este e-mail já está em uso" });
    c.email = email;
  }
  for (const k of ["telefone", "convenio", "carteirinha", "nascimento"]) if (b[k] !== undefined) c[k] = txt(b[k]);
  if (b.novaSenha) {
    if (!confereSenha(String(b.senhaAtual || ""), c.senha)) return res.status(400).json({ erro: "Senha atual incorreta" });
    if (String(b.novaSenha).length < 6) return res.status(400).json({ erro: "A nova senha precisa ter ao menos 6 caracteres" });
    c.senha = hashSenha(b.novaSenha);
  }
  c.updatedAt = new Date().toISOString();
  writeDB(req.db);
  res.json(publicoConta(c));
});

// LGPD: portabilidade
pac.get("/eu/exportar", (req, res) => {
  const id = req.conta.id, db = req.db;
  res.setHeader("Content-Disposition", 'attachment; filename="meus-dados.json"');
  res.json({
    conta: publicoConta(req.conta),
    visitas: db.pacientes.filter((x) => x.contaId === id),
    triagens: db.triagens.filter((x) => x.contaId === id),
    consultas: db.consultas.filter((x) => x.contaId === id),
    exames: db.exames.filter((x) => x.contaId === id),
    agendamentos: db.agendamentos.filter((x) => x.contaId === id)
  });
});

// LGPD: encerramento (o prontuário médico é mantido por obrigação legal)
pac.post("/eu/encerrar", (req, res) => {
  if (!confereSenha(String(req.body.senha || ""), req.conta.senha)) return res.status(400).json({ erro: "Senha incorreta" });
  req.conta.ativo = false;
  req.conta.encerradaEm = new Date().toISOString();
  writeDB(req.db);
  res.json({ ok: true });
});

// ---- agenda ----
const HORAS = [];
for (let h = 8; h < 18; h++) for (const m of ["00", "30"]) { if (h === 12 || (h === 13 && m === "00")) continue; HORAS.push(`${String(h).padStart(2, "0")}:${m}`); }
const VAGAS = 2;
const TIPOS_AGENDA = ["Consulta", "Retorno", "Exame"];

function dataValida(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || "")) return "Data inválida";
  if (data < hojeBR()) return "Escolha uma data a partir de hoje";
  if (data > new Date(BR().getTime() + 90 * 86400000).toISOString().slice(0, 10)) return "Agendamentos só até 90 dias à frente";
  if (new Date(data + "T12:00:00").getDay() === 0) return "Não atendemos aos domingos";
  return null;
}
function vagasDo(db, data, hora) {
  return VAGAS - db.agendamentos.filter((a) => a.data === data && a.hora === hora && a.status !== "cancelado").length;
}

pac.get("/horarios", (req, res) => {
  const data = String(req.query.data || "");
  const erro = dataValida(data);
  if (erro) return res.status(400).json({ erro });
  const agora = BR().toISOString().slice(11, 16);
  res.json(HORAS.map((hora) => ({ hora, vagas: data === hojeBR() && hora <= agora ? 0 : Math.max(0, vagasDo(req.db, data, hora)) })));
});

pac.get("/agenda", (req, res) => {
  res.json(req.db.agendamentos.filter((a) => a.contaId === req.conta.id)
    .sort((a, b) => `${b.data}${b.hora}`.localeCompare(`${a.data}${a.hora}`)));
});

pac.post("/agenda", (req, res) => {
  const b = req.body || {}, db = req.db, c = req.conta;
  const erro = dataValida(b.data);
  if (erro) return res.status(400).json({ erro });
  if (!HORAS.includes(b.hora)) return res.status(400).json({ erro: "Horário inválido" });
  if (b.data === hojeBR() && b.hora <= BR().toISOString().slice(11, 16)) return res.status(400).json({ erro: "Este horário já passou" });
  const tipo = TIPOS_AGENDA.includes(b.tipo) ? b.tipo : "Consulta";
  if (vagasDo(db, b.data, b.hora) <= 0) return res.status(409).json({ erro: "Este horário acabou de ser preenchido. Escolha outro." });
  const meus = db.agendamentos.filter((a) => a.contaId === c.id && a.status !== "cancelado" && a.status !== "realizado" && a.data >= hojeBR());
  if (meus.some((a) => a.data === b.data && a.hora === b.hora)) return res.status(409).json({ erro: "Você já tem um agendamento neste horário" });
  if (meus.length >= 5) return res.status(400).json({ erro: "Limite de 5 agendamentos ativos. Cancele algum para marcar outro." });

  const ag = { id: novoId(), paciente: c.nome, contaId: c.id, medico: txt(b.medico) || "Clínica geral", data: b.data, hora: b.hora,
    tipo, status: "agendado", obs: txt(b.obs).slice(0, 300), origem: "portal", createdAt: new Date().toISOString() };
  db.agendamentos.push(ag);
  writeDB(db);
  res.json(ag);
});

pac.delete("/agenda/:id", (req, res) => {
  const ag = req.db.agendamentos.find((a) => String(a.id) === req.params.id && a.contaId === req.conta.id);
  if (!ag) return res.status(404).json({ erro: "Agendamento não encontrado" });
  if (ag.status === "realizado") return res.status(400).json({ erro: "Consultas realizadas não podem ser canceladas" });
  ag.status = "cancelado";
  ag.canceladoPor = "paciente";
  writeDB(req.db);
  res.json(ag);
});

// ---- check-in (chegada ao hospital) ----
pac.post("/checkin", (req, res) => {
  const db = req.db, c = req.conta, hoje = hojeBR();
  let v = db.pacientes.find((p) => p.contaId === c.id && p.createdAt && diaBR(p.createdAt) === hoje && p.status !== "atendido");
  const jaTinha = !!v;
  if (!v) {
    v = { id: Date.now(), nome: c.nome, cpf: fmtCPF(c.cpf), tipo: c.convenio === "Particular" ? "Particular" : "Convenio",
      status: "triagem", contaId: c.id, origem: "autoatendimento", queixa: txt(req.body.queixa).slice(0, 300),
      senha: proximaSenha(db), createdAt: new Date().toISOString() };
    db.pacientes.push(v);
  }
  const ag = db.agendamentos.filter((a) => a.contaId === c.id && a.data === hoje && a.status === "agendado")
    .sort((a, b) => (a.hora || "").localeCompare(b.hora || ""))[0];
  if (ag) { ag.status = "confirmado"; ag.checkin = true; }
  writeDB(db);
  res.json({ visita: v, jaTinha });
});

// ---- jornada ao vivo ----
pac.get("/jornada", (req, res) => {
  const db = req.db, c = req.conta, hoje = hojeBR();
  const v = db.pacientes.filter((p) => p.contaId === c.id && p.createdAt && diaBR(p.createdAt) === hoje)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop();
  if (!v) return res.json({ visita: null });

  const depois = (x) => String(x.createdAt) >= String(v.createdAt);
  const tri = db.triagens.filter((t) => (t.contaId === c.id || nomeIgual(t.nome, c.nome)) && depois(t)).pop();
  const con = db.consultas.filter((x) => (x.contaId === c.id || nomeIgual(x.paciente, c.nome)) && depois(x)).pop();
  const exPend = db.exames.filter((e) => e.contaId === c.id && e.status !== "pronto").length;

  const filaTri = db.pacientes.filter((p) => p.status === "triagem" && p.createdAt && diaBR(p.createdAt) === hoje)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const peso = { vermelho: 0, amarelo: 1, verde: 2 };
  const filaMed = db.triagens.filter((t) => (!t.status || t.status === "aguardando_medico") && t.createdAt && diaBR(t.createdAt) === hoje)
    .sort((a, b) => (peso[a.risco] ?? 3) - (peso[b.risco] ?? 3) || String(a.createdAt).localeCompare(String(b.createdAt)));
  const posTri = v.status === "triagem" ? filaTri.findIndex((p) => p.id === v.id) + 1 : 0;
  const posMed = tri && !con ? filaMed.findIndex((t) => t.id === tri.id) + 1 : 0;

  const ch = db.tv_chamada;
  const chamada = ch && nomeIgual(ch.paciente, c.nome) && Date.now() - Number(ch.id) < 15 * 60 * 1000 ? ch : null;

  const etapas = [
    { id: "checkin", rot: "Check-in", det: `Sua senha: ${v.senha || "—"}`, estado: "ok" },
    { id: "triagem", rot: "Triagem", det: tri ? `Classificação: ${tri.risco}` : posTri ? `${posTri}º na fila` : "Aguardando enfermagem", estado: tri ? "ok" : "atual" },
    { id: "medico", rot: "Consulta médica", det: con ? "Concluída" : posMed ? `${posMed}º na fila do médico` : "Aguardando", estado: con ? "ok" : tri ? "atual" : "pendente" },
    { id: "prescricao", rot: "Prescrição e exames", det: con ? (exPend ? `${exPend} exame(s) em andamento` : "Receita disponível") : "Após a consulta", estado: con ? "ok" : "pendente" },
    { id: "alta", rot: "Alta", det: con && v.status === "atendido" ? "Atendimento finalizado" : "Ao final do atendimento", estado: con && v.status === "atendido" ? "ok" : "pendente" }
  ];
  res.json({
    visita: { senha: v.senha, status: v.status, createdAt: v.createdAt, queixa: v.queixa },
    risco: tri ? tri.risco : null, etapas, posicao: { triagem: posTri, medico: posMed }, chamada,
    resumo: con ? { diagnostico: con.diagnostico, medicacao: con.medicacao, obs: con.obs } : null
  });
});

// ---- histórico, receitas e exames (somente registros vinculados à conta) ----
pac.get("/historico", (req, res) => {
  const id = req.conta.id, ord = (l) => [...l].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({
    consultas: ord(req.db.consultas.filter((x) => x.contaId === id)),
    triagens: ord(req.db.triagens.filter((x) => x.contaId === id)).map((t) => ({ id: t.id, risco: t.risco, sintoma: t.sintoma || t.sintomas, createdAt: t.createdAt }))
  });
});
pac.get("/exames", (req, res) => {
  res.json([...req.db.exames.filter((e) => e.contaId === req.conta.id)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((e) => ({ ...e, resultado: e.status === "pronto" ? e.resultado : "" })));
});

app.use("/paciente-api", pac);

// ---------- portal da equipe (/app-api) ----------

const staff = express.Router();

const PERM_STAFF = {
  atendimento: { pacientes: "rw", agendamentos: "rw", triagens: "r", exames: "r", leitos: "r", avisos: "r", equipe: "r" },
  triagem: { pacientes: "r", triagens: "rw", consultas: "r", exames: "r", agendamentos: "r", leitos: "r", avisos: "r", equipe: "r" },
  medico: { pacientes: "r", triagens: "rw", consultas: "rw", exames: "rw", medicacoes: "r", agendamentos: "rw", leitos: "rw", almox_itens: "r", avisos: "r", equipe: "r" },
  farmacia: { almox_itens: "rw", almox_movimentos: "r", almox_fornecedores: "rw", medicacoes: "rw", leitos: "r", avisos: "r", equipe: "r" },
  admin: { ...Object.fromEntries(Object.keys(SCHEMAS).map((k) => [k, "rw"])), almox_movimentos: "r" }
};
const EXCLUIR_STAFF = ["agendamentos", "almox_fornecedores", "medicacoes"];

staff.use((req, res, next) => {
  const db = readDB();
  const token = req.headers["x-token"] || req.headers["x-admin-token"];
  const p = verificar(token, db.config.secret);
  const user = p && db.usuarios.find((u) => u.id === p.id);
  if (!user || user.ativo === false) return res.status(401).json({ erro: "Sessão expirada. Entre novamente." });
  req.db = db;
  req.admin = user;
  next();
});

staff.get("/permissoes", (req, res) => {
  res.json({ usuario: req.admin.usuario, tipo: req.admin.tipo, perm: PERM_STAFF[req.admin.tipo] || {} });
});

staff.get("/resumo", (req, res) => {
  const db = req.db;
  const hoje = new Date().toISOString().slice(0, 10);
  const dia = (x) => (x.createdAt || "").slice(0, 10) === hoje;
  const fila = db.triagens.filter((t) => !t.status || t.status === "aguardando_medico");
  res.json({
    filaTriagem: db.pacientes.filter((p) => p.status === "triagem").length,
    filaMedico: fila.length,
    vermelhos: fila.filter((t) => t.risco === "vermelho").length,
    pacientesHoje: db.pacientes.filter(dia).length,
    consultasHoje: db.consultas.filter(dia).length,
    leitosLivres: db.leitos.filter((l) => l.status === "livre").length,
    leitosTotal: db.leitos.length,
    agendaHoje: db.agendamentos.filter((a) => a.data === hoje && a.status !== "cancelado").length,
    alertasEstoque: db.almox_itens.filter((i) => situacaoItem(i) !== "ok").length
  });
});

staff.get("/prontuario", (req, res) => {
  if (!["medico", "triagem", "atendimento", "admin"].includes(req.admin.tipo)) {
    return res.status(403).json({ erro: "Sem permissão para consultar prontuários" });
  }
  const q = String(req.query.nome || "").trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const bate = (v) => String(v || "").toLowerCase().includes(q);
  const ev = [];
  for (const p of req.db.pacientes) if (bate(p.nome)) ev.push({ tipo: "cadastro", data: p.createdAt, paciente: p.nome, titulo: "Cadastro na recepção", detalhe: [p.tipo, p.cpf && `CPF ${p.cpf}`, p.senha && `Senha ${p.senha}`, p.queixa && `Queixa: ${p.queixa}`].filter(Boolean).join(" • ") });
  for (const t of req.db.triagens) if (bate(t.nome)) ev.push({ tipo: "triagem", data: t.createdAt, paciente: t.nome, risco: t.risco, titulo: `Triagem • risco ${t.risco || "—"}`,
    detalhe: [t.sintoma || t.sintomas, (t.temperatura ?? t.temp) !== undefined && `${t.temperatura ?? t.temp} °C`, t.alergia && `Alergia: ${t.alergia}`, t.observacao].filter(Boolean).join(" • ") });
  for (const c of req.db.consultas) if (bate(c.paciente)) ev.push({ tipo: "consulta", data: c.createdAt, paciente: c.paciente, titulo: "Consulta médica",
    detalhe: [c.diagnostico && `Diagnóstico: ${c.diagnostico}`, c.medicacao && `Medicação: ${c.medicacao}`, c.obs].filter(Boolean).join(" • ") });
  for (const a of req.db.agendamentos) if (bate(a.paciente)) ev.push({ tipo: "agendamento", data: `${a.data}T${a.hora || "00:00"}`, paciente: a.paciente, titulo: `Agendamento • ${a.status}`,
    detalhe: [a.tipo, a.medico, a.obs].filter(Boolean).join(" • ") });
  ev.sort((a, b) => String(b.data).localeCompare(String(a.data)));
  res.json(ev.slice(0, 200));
});

staff.use((req, res, next) => {
  const m = req.path.match(/^\/colecao\/([^/]+)/);
  const col = m ? m[1] : req.path.startsWith("/almox/") ? "almox_itens" : null;
  const nivel = col && (PERM_STAFF[req.admin.tipo] || {})[col];
  const escrita = req.method !== "GET";
  if (!nivel || (escrita && nivel !== "rw") || (req.method === "DELETE" && !EXCLUIR_STAFF.includes(col))) {
    return res.status(403).json({ erro: "Seu perfil não tem permissão para esta ação" });
  }
  next();
});
staff.use(crud);

app.use("/app-api", staff);
app.use("/admin-api", admin);

// ======================================================
// 404 + ERROS
// ======================================================

app.use((req, res) => {
  res.status(404).json({ erro: "Rota não encontrada", rota: req.originalUrl });
});

app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err);
  res.status(500).json({ erro: "Erro interno do servidor" });
});

// ======================================================
// INICIAR
// ======================================================

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));
}
