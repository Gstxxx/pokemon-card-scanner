# API

O servidor (`src/server.ts`) expõe um WebSocket para o scanner e rotas REST para o álbum. Tudo é
servido nas mesmas portas: HTTP (`PORT`, padrão 3002) e, com certificado, HTTPS (`PORT_HTTPS`,
padrão 3443).

## WebSocket `/ws`

Mensagens JSON em texto. O cliente envia imagens em base64 (JPEG ou PNG, sem o prefixo `data:`).

### Servidor → cliente ao conectar

```json
{ "type": "hello", "boot": 1792706000000 }
```

`boot` identifica o processo do servidor. O front recarrega a página quando ele muda (reinício em
modo watch), para pegar HTML/JS novos.

### Detecção ao vivo

Cliente, a cada ~2,5 s:

```json
{ "type": "frame", "data": "<base64>" }
```

Servidor responde com **uma** das mensagens:

```json
{ "type": "maybe", "name": "Charmeleon" }   // leu um nome de Pokémon válido
{ "type": "no_card" }                        // frame vazio, nada legível ou nome inválido
```

`frame` nunca retorna `card`: é uma leitura barata só para disparar a confirmação.

### Confirmação

Ao receber `maybe`, o cliente congela a câmera, tira uma foto em qualidade máxima e envia:

```json
{ "type": "confirm", "data": "<base64>" }
```

Servidor pré-processa a foto (PNG sem perda, upscale só se for pequena), relê, valida o nome,
busca preço e responde:

```json
{
  "type": "card",
  "name": "Charmeleon",
  "set": "Phantasmal Flames",
  "number": "13",
  "image": "https://images.pokemontcg.io/me2/13_hires.png",
  "currency": "USD",
  "prices": { "low": 0.1, "mid": 0.25, "high": 2.5, "market": 0.21 },
  "finish": "holofoil",
  "variant": "holofoil",
  "brl": 1.06
}
```

ou `{ "type": "no_card" }` se a releitura falhar ou a carta não existir no banco do TCG.
`currency` é `USD` (TCGPlayer) ou `EUR` (Cardmarket, via TCGdex). `brl` é `null` quando o câmbio
ainda não foi carregado. `finish` é o que o modelo viu na carta física; `variant` é a chave de preço
efetivamente usada (`holofoil`, `reverseHolofoil`, `normal`, `1stEditionHolofoil`, `cardmarket`…).

### Erros

```json
{ "type": "error", "message": "Processing failed" }
```

## REST

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/cards` | lista do álbum em ordem de leitura (`id` crescente) |
| `POST` | `/api/cards` | adiciona uma carta (mesmo corpo da mensagem `card`); `201` se nova, `200` se já existia (`created: false`); dedupe por `name` + `number` |
| `DELETE` | `/api/cards/:id` | remove uma carta |
| `GET` | `/api/cards.csv` | exporta o álbum (`name, set, number, market, currency, added_at`) |
| `GET` | `/api/fx` | câmbio atual `{ "usdBrl", "eurBrl", "fetchedAt" }` |
| `GET` | `/api/phone` | URLs HTTPS da LAN para o celular (`404` sem certificado) |
| `GET` | `/qr.svg` | QR code SVG da primeira URL HTTPS da LAN |
| `GET` | `/*` | arquivos estáticos de `src/public` |

Exemplo de linha do álbum (`GET /api/cards`):

```json
{
  "id": 7,
  "name": "Bulbasaur",
  "set": "Base",
  "number": "44",
  "image": "https://images.pokemontcg.io/base1/44_hires.png",
  "currency": "USD",
  "prices": { "low": 2.5, "mid": 4.0, "high": 20.0, "market": 4.26 },
  "finish": "normal",
  "variant": "normal",
  "brl": 21.4,
  "added_at": "2026-10-22T22:50:11.000Z"
}
```

## Banco de dados

`album.db` (SQLite, criado na raiz na primeira execução) com a tabela `cards`:

```
id INTEGER PK · key TEXT UNIQUE (name||number) · name · set_name · number · image ·
currency · market REAL · low REAL · mid REAL · high REAL · finish · variant · brl REAL · added_at
```

Apague o arquivo para zerar o álbum.
