// Ponte segura entre a interface e o processo principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  carregar: () => ipcRenderer.invoke('dados:carregar'),
  salvar: (dados) => ipcRenderer.invoke('dados:salvar', dados),
  adicionarAnexos: (solId, arquivos) => ipcRenderer.invoke('anexo:adicionar', solId,
    arquivos ? Array.from(arquivos, (f) => (typeof f === 'string' ? f : webUtils.getPathForFile(f))) : undefined),
  abrirAnexo: (solId, arquivo) => ipcRenderer.invoke('anexo:abrir', solId, arquivo),
  removerAnexo: (solId, arquivo) => ipcRenderer.invoke('anexo:remover', solId, arquivo),
  salvarTexto: (nome, conteudo, filtro) => ipcRenderer.invoke('arquivo:salvarTexto', nome, conteudo, filtro),
  importarBackup: () => ipcRenderer.invoke('backup:importar'),
  abrirPasta: () => ipcRenderer.invoke('pasta:abrir'),
  escolherPasta: () => ipcRenderer.invoke('pasta:escolher'),
  versao: () => ipcRenderer.invoke('app:versao'),
});
