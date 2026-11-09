// Mantido por compatibilidade: usa a mesma aplicação de api/index.js
const app = require("../api/index.js");

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor rodando na porta ${PORT}`));
