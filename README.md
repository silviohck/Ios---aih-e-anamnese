# AIH & Anamnese

Web app para iPhone que recebe o **PDF do paciente com AIH e anamnese juntos**, já com o cadastro preenchido (nome, endereço, Cartão SUS…), e:

1. **Identifica todos os campos sozinho** e mostra o que já veio preenchido (marcado como **do PDF**). Esses dados são mantidos.
2. **Completa automaticamente os campos que você fixou** (marcados como **fixo**), como estabelecimento, clínica ou médico solicitante.
3. Deixa você **completar o resto**. A opção **Mostrar só campos vazios** mostra só o que falta.
4. **Gera o PDF preenchido** e envia para **impressão (AirPrint)** pela folha de compartilhamento do iPhone.
5. **Grava os dados dentro do próprio PDF**:
   - metadados do arquivo: Título (com o nome do paciente), Assunto, Palavras-chave;
   - chave própria `AIHAnamneseDados` no dicionário de informações do PDF, com todos os campos em JSON e a **origem de cada valor** (`pdf`, `fixo` ou `digitado`);
   - anexo `dados-preenchidos.json` dentro do PDF.

   Se você abrir de novo um PDF gerado pelo app, ele lê esses dados e preenche os campos.

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

O workflow `.github/workflows/pages.yml` publica o app quando há push na branch `main`.
Para ativar: **Settings → Pages → Source: GitHub Actions**.
(Em repositório privado, o GitHub Pages exige plano pago. Outra opção é qualquer hospedagem de site estático com HTTPS, como Netlify ou Cloudflare Pages.)

Os arquivos publicados são só o código do app. Nenhum PDF ou dado de paciente fica no repositório.

## Limitações

- O PDF precisa ter **campos preenchíveis** (AcroForm). PDFs só com imagem ainda não são suportados.
- O texto impresso usa a fonte Helvetica, que aceita acentos do português. Símbolos fora desse conjunto (ex.: `→`, emojis) saem como `?` no papel, mas ficam gravados corretamente nos dados do PDF.

## Desenvolvimento

Não tem etapa de build: são arquivos estáticos. A biblioteca [pdf-lib](https://pdf-lib.js.org) 1.17.1 (licença MIT) está em `vendor/`.

```sh
python3 -m http.server 8123          # servir localmente
node tests/make-sample.js            # gera tests/exemplo-paciente-1.pdf e -2.pdf
node tests/e2e.js                    # teste completo no navegador (requer Playwright)
```

Ao publicar mudanças, altere `VERSION` em `sw.js` para o iPhone baixar a versão nova.
