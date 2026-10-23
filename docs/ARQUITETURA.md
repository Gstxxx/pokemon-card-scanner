# Arquitetura

## Pipeline

```
câmera ──frame (2,5 s)──▶ WebSocket ──▶ isBlank? ──▶ Qwen2.5-VL: "transcreva o nome"
                                                          │
                                              matchPokemon (PokéAPI)
                                                          │ nome válido
                                     ◀── maybe ───────────┘
   congela câmera, foto em alta qualidade
            ──confirm──▶ upscale/PNG ──▶ Qwen2.5-VL: nome + número "013/094" + acabamento
                                                          │
                                              matchPokemon ──▶ pricing:
                                                  pokemontcg.io  name + number + set.printedTotal
                                                  ▸ ranking: nome exato › número › total do set › tem preço
                                                  ▸ variante por acabamento (holo/reverse/normal)
                                                  ▸ fallback TCGdex (TCGPlayer USD ou Cardmarket EUR)
                                                          │
                                                  fx: USD/EUR → BRL
                                                          │
                                     ◀── card ────────────┘
   POST /api/cards (SQLite) · cola no fichário · câmera volta
```

Duas leituras por carta: a primeira é barata e serve só como gatilho; a segunda, em cima de uma foto
congelada e sem compressão agressiva, é a que decide. Isso substituiu a regra anterior de "mesmo
nome em dois frames seguidos" — mais rápida e dá feedback visual (loading sobre a foto).

## Componentes

| Arquivo | Responsabilidade |
|---|---|
| `src/server.ts` | `Bun.serve` HTTP e HTTPS compartilhando `fetch`/`websocket`; Hono para REST e estáticos; fila sequencial de preços (pokemontcg.io devolve 5xx em rajadas) |
| `src/services/vision.ts` | prompt de transcrição, parsing tolerante (code fences, campos faltando), normalização de número (`013/094` → `13` + total `94`) e acabamento |
| `src/services/pokedex.ts` | ~1.000 nomes da PokéAPI em memória; match exato → inclusão → Dice de bigramas / Levenshtein (limiar 0,72); leituras com menos de 6 letras só casam exatas |
| `src/services/pricing.ts` | busca escalonada (nome+número+total → nome+total → nome+número → nome), `pickBest` com pesos, variante por acabamento, timeout 8 s, retry com backoff, TCGdex como fallback |
| `src/services/fx.ts` | câmbio em cache por 1 h |
| `src/services/upscale.ts` | `isBlank` (desvio-padrão dos pixels) para não mandar frame vazio ao modelo; re-encode PNG e upscale só abaixo de 800 px |
| `src/services/album.ts` | `bun:sqlite`, migração por `ALTER TABLE` para colunas novas, CSV |
| `src/public/app.js` | captura só a região visível do visor (recorte `object-fit: cover`), 1080p, JPEG 0,8 ao vivo / 0,95 na foto; máquina de estados `scanning` / `confirming`; álbum via REST; QR do celular |

## Decisões e experimentos

**Por que Qwen2.5‑VL e não LLaVA.** LLaVA‑1.5 7b identifica pela arte: lia "Charizard" num
Charmeleon e inventava nomes em frames borrados (Bubbles, Bubastis). Qwen2.5‑VL lê o texto
impresso; com um prompt de *transcrição* ("copie letra por letra, não adivinhe pela arte") acertou
10/10 na bateria e nomes raros ao vivo (Lokix, Audino, Comfey).

**Prompt sem "escape".** Dar ao modelo a opção `{"error":"no_card"}` fez tanto LLaVA quanto Qwen
responderem "sem carta" para cartas visíveis. Hoje o prompt pede sempre a transcrição e devolve
string vazia quando não há nada legível; frames realmente vazios são barrados antes pelo `isBlank`
e nomes inválidos pelo `matchPokemon`.

**Upscale agressivo piora.** Ampliar para 1200–1800 px com sharpen fez o Qwen errar ("Charmander",
"Charizard") ou não ler o mesmo frame que lia bem em tamanho moderado. O "upscale" ficou
conservador: PNG sem perda e ampliação só para fotos pequenas.

**Recorte do visor.** O frame original era o 16:9 inteiro da webcam (rosto, sala, estante) — a carta
era uma fração pequena. Enviar só o recorte 3:4 visível no visor foi o maior ganho de leitura.

**Impressão exata pelo número.** Só o nome traz "Team Rocket's Mewtwo ex" ou "Mega Charizard X ex"
para um Mewtwo/Charizard comum. Número de coleção + total do set (`set.printedTotal`) apontam a
carta certa; o ranking ainda prefere nome exato e penaliza variantes com prefixo.

**OCR clássico não serve.** Tesseract não leu o nome em frames de webcam (fonte estilizada, borrão,
inclinação), nem com recorte e upscale.

**Dois frames iguais → foto confirmada.** O debounce por repetição protegia contra alucinação, mas
era lento e sem feedback. A foto congelada + releitura dá precisão melhor e UX de "scanner".

## Limites conhecidos

- Detecção de acabamento (holo/reverse) pelo modelo é pouco confiável em cartas foscas.
- Preços dependem de APIs externas instáveis; mitigado com retry, timeout, fila e fallback.
- Preço é do mercado americano (TCGPlayer); não há fonte pública para Liga Pokémon.
- Cartas sem número impresso (promos antigas) caem no melhor candidato por nome.
- O modelo precisa de GPU para ficar em ~1 s por leitura; em CPU o ciclo passa de 10 s.

## Testes

`bun run e2e` abre um WebSocket contra o servidor em execução, envia 10 cartas reais (imagens
oficiais) pelo fluxo `frame → maybe → confirm → card` e uma imagem sem carta, e imprime nome lido,
preço e tempo por carta. Serve como regressão de leitura, ranking de preço e falso positivo.
