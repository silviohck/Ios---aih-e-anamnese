# AIH & Anamnese

Web app para iPhone que:

1. **Abre um PDF com formulário** (ex.: laudo de AIH, ficha de anamnese).
2. **Identifica todos os campos sozinho** e monta uma tela para preenchê-los.
3. **Gera o PDF preenchido** e envia para **impressão (AirPrint)** pela folha de compartilhamento do iPhone.
4. **Grava os dados dentro do próprio PDF**:
   - metadados do arquivo: Título (com o nome do paciente, se houver campo de nome), Assunto, Palavras-chave;
   - chave própria `AIHAnamneseDados` no dicionário de informações do PDF, com todos os campos em JSON;
   - anexo `dados-preenchidos.json` dentro do PDF.

   Se você abrir de novo um PDF gerado pelo app, ele lê esses dados e preenche os campos automaticamente.

Tudo roda **somente no aparelho**: nenhum dado de paciente é enviado para servidor. O modelo PDF e o rascunho ficam salvos no próprio iPhone, então não é preciso escolher o PDF toda vez.

## Como usar no iPhone

1. Abra o endereço do app no **Safari**.
2. Toque em **Compartilhar → Adicionar à Tela de Início**. Ele passa a abrir como um app e funciona sem internet.
3. **Escolher PDF** → selecione o formulário (Arquivos, iCloud, e-mail…).
4. Preencha os campos. Use **Buscar campo…** se o formulário for grande.
5. **Gerar PDF preenchido** → **Imprimir / Compartilhar** → **Imprimir**.

A opção **Travar campos** deixa o PDF final sem campos editáveis. Os dados continuam gravados nos metadados e no anexo.

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
node tests/make-sample.js            # gera tests/exemplo-formulario.pdf
node tests/e2e.js                    # teste completo no navegador (requer Playwright)
```

Ao publicar mudanças, altere `VERSION` em `sw.js` para o iPhone baixar a versão nova.
