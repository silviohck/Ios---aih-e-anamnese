# Solicitações (Mac)

> Desenvolvimento focado no Mac. A versão Windows vem depois (o código já é compatível; falta gerar e testar o instalador).

App de computador para acompanhar solicitações de **exames, procedimentos, terapias, cirurgias/internações e OPME**,
tanto por **plano de saúde** quanto **particular**.

## O que faz

- **Painel**: quantas solicitações estão em aberto, a enviar, aguardando a operadora, com pendência, autorizadas a agendar
  e com prazo vencido. Lista do que **precisa de atenção** e dos **próximos agendamentos**.
- **Solicitações**: lista com busca (sem precisar de acento) e filtros por status, tipo e convênio, ou **quadro**
  em que se arrasta o cartão para mudar o status. Exporta planilha (CSV que abre no Excel).
- **Ficha da solicitação**: paciente, convênio, tipo, caráter (eletiva/urgência), procedimento, código TUSS, CID,
  médico, local de realização, protocolo, guia, senha e validade, datas de envio, resposta, agendamento e realização.
  Nas particulares: valor, forma e situação do pagamento.
- **Status**: A enviar → Enviada → Em análise → Pendência → Autorizada / Autorizada parcial / Negada → Agendada →
  Realizada (ou Cancelada). Cada mudança fica no **histórico** com data, hora e observação (ex.: motivo da negativa,
  documentos pedidos). Também dá para registrar ligações e contatos.
- **Prazos**: a partir da data de envio, calcula a **data limite da resposta em dias úteis** (pula fins de semana,
  feriados nacionais e feriados locais cadastrados). Os prazos por tipo vêm dos prazos de garantia de atendimento da ANS
  (RN 566/2022) e podem ser alterados em Configurações ou em cada solicitação. Confira a norma vigente.
- **Alertas**: prazo vencendo ou vencido, senha de autorização perto de vencer, pendência com a operadora,
  data de retorno/cobrança, agendamento que passou sem marcar como realizado e pagamento particular em aberto.
- **Anexos**: arraste pedidos médicos, laudos, guias e negativas para a solicitação. Os arquivos são copiados para a
  pasta de dados do app.
- **Imprimir ficha** da solicitação com o histórico.

## Onde ficam os dados

Tudo fica no computador, num arquivo `dados.json` e na pasta `anexos/`. Uma cópia de segurança diária é guardada
automaticamente em `backups/` (as 30 mais recentes). Em **Configurações** dá para abrir a pasta, trocar de pasta e
exportar/importar backup.

**Mais de um computador:** escolha uma pasta sincronizada (OneDrive, Dropbox, Google Drive). Se outro computador
gravar enquanto este está aberto, o app avisa e recarrega a versão mais nova em vez de sobrescrevê-la.
Não é feito para várias pessoas editarem ao mesmo tempo.

## Instalar

Os instaladores são gerados pelo GitHub Actions (workflow **App desktop (Mac)**) a cada alteração nesta pasta:
baixe em *Actions → execução mais recente → Artifacts*. Para gerar uma versão na aba *Releases*, crie uma tag
`desktop-v0.1.0`.

- **Windows**: `Solicitações Setup x.y.z.exe`. Como o instalador não tem assinatura digital, o Windows pode mostrar
  "O Windows protegeu o computador": clique em *Mais informações → Executar assim mesmo*.
- **Mac**: `Solicitações-x.y.z-universal.dmg` (Intel e Apple Silicon). Sem assinatura da Apple, na primeira vez abra
  pelo Finder com clique direito → *Abrir*, ou em *Ajustes do Sistema → Privacidade e Segurança → Abrir mesmo assim*.

## Desenvolvimento

```bash
cd desktop
npm install
npm start              # abre o app
npm test               # testes das regras de prazo, status e filtros
npm run test:e2e       # abre o app e percorre o fluxo completo (requer Playwright)
npm run dist:mac       # gera o .dmg (num Mac)
npm run dist:win       # gera o instalador .exe (no Windows)
```

Estrutura: `src/main.js` (janela, arquivo de dados, anexos, backup), `src/preload.js` (ponte segura),
`src/renderer/` (interface: `logic.js` com as regras, `app.js` com as telas, `styles.css`).
