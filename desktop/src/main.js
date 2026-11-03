// Processo principal: janela, arquivo de dados, anexos, backup.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARQUIVO = 'dados.json';
let janela;
let ultimaVersaoLida = null; // mtime do arquivo quando foi lido/gravado por nós

// ---------- Pasta de dados ----------
// Por padrão fica na pasta do usuário do app. Pode ser trocada (ex.: OneDrive/Dropbox)
// em Configurações; a escolha fica em preferencias.json.
const arquivoPreferencias = () => path.join(app.getPath('userData'), 'preferencias.json');
function lerPreferencias() {
  try { return JSON.parse(fs.readFileSync(arquivoPreferencias(), 'utf8')); } catch { return {}; }
}
function gravarPreferencias(p) {
  fs.mkdirSync(path.dirname(arquivoPreferencias()), { recursive: true });
  fs.writeFileSync(arquivoPreferencias(), JSON.stringify(p, null, 2));
}
function pastaDados() {
  const p = process.env.SOLICITACOES_DADOS || lerPreferencias().pastaDados || path.join(app.getPath('userData'), 'dados');
  fs.mkdirSync(p, { recursive: true });
  return p;
}
const caminhoDados = () => path.join(pastaDados(), ARQUIVO);
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };

function carregar() {
  const f = caminhoDados();
  let dados = null;
  if (fs.existsSync(f)) {
    dados = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  ultimaVersaoLida = mtime(f);
  return { dados, pasta: pastaDados() };
}

function gravarAtomico(f, conteudo) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, conteudo);
  fs.renameSync(tmp, f);
}

// Uma cópia por dia em backups/, mantém as 30 mais recentes
function backupDiario(f) {
  if (!fs.existsSync(f)) return;
  const dir = path.join(path.dirname(f), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `dados-${new Date().toISOString().slice(0, 10)}.json`);
  if (!fs.existsSync(destino)) fs.copyFileSync(f, destino);
  const antigos = fs.readdirSync(dir).filter((n) => /^dados-.*\.json$/.test(n)).sort().slice(0, -30);
  for (const n of antigos) fs.rmSync(path.join(dir, n), { force: true });
}

function salvar(dados) {
  const f = caminhoDados();
  const atual = mtime(f);
  // Outro computador (pasta compartilhada) gravou depois da nossa leitura
  if (atual !== null && ultimaVersaoLida !== null && Math.abs(atual - ultimaVersaoLida) > 1) {
    return { ok: false, conflito: true };
  }
  backupDiario(f);
  gravarAtomico(f, JSON.stringify(dados, null, 1));
  ultimaVersaoLida = mtime(f);
  return { ok: true };
}

// ---------- Anexos ----------
const nomeSeguro = (n) => n.replace(/[\\/:*?"<>|]/g, '_');
const pastaAnexos = (solId) => path.join(pastaDados(), 'anexos', nomeSeguro(solId));

async function adicionarAnexos(solId, caminhos) {
  if (!caminhos) {
    const r = await dialog.showOpenDialog(janela, {
      title: 'Anexar arquivos à solicitação',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Documentos', extensions: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'doc', 'docx', 'xls', 'xlsx', 'txt'] },
        { name: 'Todos os arquivos', extensions: ['*'] }],
    });
    if (r.canceled) return [];
    caminhos = r.filePaths;
  }
  const dir = pastaAnexos(solId);
  fs.mkdirSync(dir, { recursive: true });
  return caminhos.map((orig) => {
    const nome = path.basename(orig);
    const arquivo = `${crypto.randomBytes(3).toString('hex')}-${nomeSeguro(nome)}`;
    fs.copyFileSync(orig, path.join(dir, arquivo));
    return { id: crypto.randomUUID(), nome, arquivo, adicionadoEm: new Date().toISOString() };
  });
}

// ---------- IPC ----------
function registrarIPC() {
  ipcMain.handle('dados:carregar', () => carregar());
  ipcMain.handle('dados:salvar', (_e, dados) => salvar(dados));

  ipcMain.handle('anexo:adicionar', (_e, solId, caminhos) => adicionarAnexos(solId, caminhos));
  ipcMain.handle('anexo:abrir', (_e, solId, arquivo) => shell.openPath(path.join(pastaAnexos(solId), nomeSeguro(arquivo))));
  ipcMain.handle('anexo:remover', (_e, solId, arquivo) => {
    fs.rmSync(path.join(pastaAnexos(solId), nomeSeguro(arquivo)), { force: true });
    return true;
  });

  ipcMain.handle('arquivo:salvarTexto', async (_e, nomeSugerido, conteudo, filtro) => {
    const r = await dialog.showSaveDialog(janela, {
      defaultPath: path.join(app.getPath('documents'), nomeSugerido),
      filters: [filtro],
    });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, conteudo);
    return r.filePath;
  });

  ipcMain.handle('backup:importar', async () => {
    const r = await dialog.showOpenDialog(janela, {
      title: 'Importar backup', properties: ['openFile'], filters: [{ name: 'Backup', extensions: ['json'] }],
    });
    if (r.canceled) return null;
    return JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
  });

  ipcMain.handle('pasta:abrir', () => shell.openPath(pastaDados()));
  ipcMain.handle('pasta:escolher', async () => {
    const r = await dialog.showOpenDialog(janela, {
      title: 'Escolha a pasta onde os dados serão guardados',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled) return null;
    const nova = r.filePaths[0];
    const antiga = pastaDados();
    if (path.resolve(nova) === path.resolve(antiga)) return { pasta: antiga, mudou: false };
    const jaTemDados = fs.existsSync(path.join(nova, ARQUIVO));
    if (!jaTemDados) {
      // Leva os dados e anexos atuais para a nova pasta
      for (const item of [ARQUIVO, 'anexos']) {
        const de = path.join(antiga, item);
        if (fs.existsSync(de)) fs.cpSync(de, path.join(nova, item), { recursive: true });
      }
    }
    gravarPreferencias({ ...lerPreferencias(), pastaDados: nova });
    return { pasta: nova, mudou: true, usouExistente: jaTemDados };
  });

  ipcMain.handle('app:versao', () => app.getVersion());
}

// ---------- Janela ----------
function criarJanela() {
  janela = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'Solicitações',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  janela.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links externos (site da operadora) abrem no navegador
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  janela.webContents.on('will-navigate', (e) => e.preventDefault());
}

function menu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'Arquivo', submenu: [mac ? { role: 'close', label: 'Fechar janela' } : { role: 'quit', label: 'Sair' }] },
    { role: 'editMenu', label: 'Editar' },
    { label: 'Exibir', submenu: [{ role: 'reload', label: 'Recarregar' }, { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' },
      { type: 'separator' }, { role: 'resetZoom', label: 'Tamanho normal' }, { role: 'zoomIn', label: 'Aumentar' },
      { role: 'zoomOut', label: 'Diminuir' }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Tela cheia' }] },
    { role: 'windowMenu', label: 'Janela' },
  ]));
}

// Datas, números e menus de contexto em português
app.commandLine.appendSwitch('lang', 'pt-BR');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus(); } });
  app.whenReady().then(() => {
    registrarIPC();
    menu();
    criarJanela();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) criarJanela(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
