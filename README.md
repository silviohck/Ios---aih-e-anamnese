# AIH & Anamnese

Web app para iPhone que recebe o **PDF do paciente com AIH e anamnese juntos**, já com o cadastro preenchido (nome, endereço, Cartão SUS…), e:

1. **Identifica todos os campos sozinho** e mostra o que já veio preenchido (marcado como **do PDF**). Esses dados são mantidos.
2. **Completa automaticamente os campos que você fixou** (marcados como **fixo**), como estabelecimento, clínica ou médico solicitante.
3. Completa campos com **atalhos**: um toque e vários campos recebem textos pré-definidos (ver abaixo). O resto você digita. A opção **Mostrar só campos vazios** mostra só o que falta.
4. **Gera o PDF preenchido** e envia para **impressão (AirPrint)** pela folha de compartilhamento do iPhone.
5. **Grava os dados dentro do próprio PDF**:
   - metadados do arquivo: Título (com o nome do paciente), Assunto, Palavras-chave;
   - chave própria `AIHAnamneseDados` no dicionário de informações do PDF, com todos os campos em JSON, a **origem de cada valor** (`pdf`, `atalho`, `fixo` ou `digitado`) e os atalhos usados;
   - anexo `dados-preenchidos.json` dentro do PDF.

   Se você abrir de novo um PDF gerado pelo app, ele lê esses dados e preenche os campos.

## Locais de atendimento e documento favorito

Se você atende em mais de um lugar, cada **local de atendimento** tem:
- o seu **documento favorito**: o formulário em branco daquele local, que abre com um toque em **Abrir documento favorito**, sem procurar o arquivo;
- os seus **valores fixos** (ex.: estabelecimento, clínica).

Os **atalhos** valem para todos os locais.

- **Configurar:** em **Gerenciar locais**, crie ou renomeie o local. Depois abra o PDF em branco dele e toque em **Tornar este PDF o favorito**.
- **Trocar de local:** escolha na lista do topo. O favorito daquele local já abre.
- **Novo atendimento:** **Abrir documento favorito**. Se houver um preenchimento em andamento desse mesmo documento, o app pergunta se você quer continuar ou começar um novo, para nunca misturar dois pacientes.
- O PDF gerado registra o local (`localAtendimento`).

## Atalhos

Um atalho é um conjunto de textos com nome (ex.: "Apendicite") que preenche vários campos de uma vez: CID, queixa, HDA, clínica…

- **Criar:** preencha os campos com o texto desejado, toque em **+ Salvar como atalho**, dê um nome e marque quais campos entram. O cadastro que veio no PDF não entra em atalho.
- **Usar:** toque no botão do atalho. Aparece um aviso com **Desfazer**.
- **Combinar:** em campos de texto longo (ex.: HDA) que já têm texto, o atalho **acrescenta** o texto numa nova linha, sem apagar o que já está lá; aplicar o mesmo atalho de novo não duplica. Nos demais campos, o valor é substituído.
- **O que veio no PDF nunca é alterado** por um atalho.
- Cada campo mostra a etiqueta com o nome do atalho que o preencheu (ex.: "Apendicite + Febre"), e o PDF gerado registra quais atalhos foram usados (`atalhosAplicados`).
- **Gerenciar atalhos e backup:** lista os atalhos (com opção de remover) e permite **exportar/importar um backup** (arquivo `.json` com atalhos, locais e valores fixos; os PDFs favoritos não entram). Atalhos e valores fixos ficam só no iPhone, então vale guardar um backup.
- Para editar um atalho, preencha a tela como quiser e salve com o mesmo nome: o app pergunta se deve substituir.

## Valores fixos

Ao lado de cada campo há o botão **Fixar**. Ele guarda o valor atual daquele campo, e em todo PDF novo esse valor é preenchido automaticamente, **somente se o campo vier vazio**. O que já vem no PDF nunca é substituído.

- **Fixado ✓**: o campo está com o valor fixo. Toque para deixar de fixar.
- **Atualizar fixo**: você mudou o valor. Toque para que o novo valor passe a ser o fixo.
- A lista **Valores fixos** mostra todos eles e permite remover.

Os valores fixos são reconhecidos pelo nome interno do campo, então valem para todos os PDFs do mesmo formulário.

## Como usar no iPhone

1. Abra o endereço do app no **Safari**.
2. Toque em **Compartilhar → Adicionar à Tela de Início**. Ele passa a abrir como um app e funciona sem internet.
3. **Abrir PDF** → escolha o PDF do paciente (Arquivos, iCloud, e-mail…).
4. Confira e complete os campos. Na primeira vez, toque em **Fixar** nos campos que devem vir sempre preenchidos.
5. **Gerar PDF preenchido** → **Imprimir / Compartilhar** → **Imprimir**.

Os últimos 15 PDFs abertos ficam na lista do topo, cada um com o seu rascunho, para você retomar depois. **Restaurar como veio no PDF** desfaz o que foi digitado (e reaplica os valores fixos). A opção **Travar campos** deixa o PDF final sem campos editáveis; os dados continuam gravados nos metadados e no anexo.

Tudo roda **somente no aparelho**: nenhum dado de paciente é enviado para servidor.

## Publicação (GitHub Pages)

Endereço: **https://silviohck.github.io/Ios---aih-e-anamnese/**

O workflow `.github/workflows/pages.yml` publica o app a cada push na branch principal.
Para ativar: **Settings → Pages → Source: GitHub Actions**.

Os arquivos publicados são só o código do app. Nenhum PDF ou dado de paciente fica no repositório.

## Limitações

- O PDF precisa ter **campos preenchíveis** (AcroForm). PDFs só com imagem ainda não são suportados.
- O texto impresso usa a fonte Helvetica, que aceita acentos do português. Símbolos fora desse conjunto (ex.: `→`, emojis) saem como `?` no papel, mas ficam gravados corretamente nos dados do PDF.

## Desenvolvimento

Não tem etapa de build: são arquivos estáticos. A biblioteca [pdf-lib](https://pdf-lib.js.org) 1.17.1 (licença MIT) está em `vendor/`.

```sh
python3 -m http.server 8123          # servir localmente
node tests/make-sample.js            # gera os PDFs de exemplo em tests/
node tests/e2e.js                    # teste completo no navegador (requer Playwright)
```

Ao publicar mudanças, altere `VERSION` em `sw.js` para o iPhone baixar a versão nova.
