# Excalidraw Self-Host (Frontend + Backend no mesmo Node)

Aplicacao de desenho colaborativo em tempo real usando:

- React + Vite no frontend
- Node.js + Express no backend
- WebSocket (`ws`) para sincronizacao de sala

Com esta configuracao, duas ou mais pessoas podem abrir o mesmo link de sala e desenhar juntas ao mesmo tempo.

## Requisitos

- Node.js 18+
- npm 9+

## Setup rapido

1. Instale dependencias:

```bash
npm install
```

2. Rode em desenvolvimento (frontend + backend juntos):

```bash
npm run dev
```

3. Abra no navegador:

```text
http://localhost:5173
```

## Como usar colaboracao por sala

1. Abra a aplicacao no navegador.
2. A app cria automaticamente um parametro `room` na URL (se nao existir).
3. Clique em `Copiar link da sala`.
4. Envie esse link para outra pessoa.
5. Ambos devem abrir o mesmo link para editar a mesma cena.

Exemplo de URL de sala:

```text
http://localhost:5173/?room=abc123xy
```

## Scripts

- `npm run dev`: sobe servidor unico em modo desenvolvimento (Node + Vite middleware + WebSocket)
- `npm run build`: gera build de producao em `dist/`
- `npm run start`: sobe servidor unico em modo producao (serve `dist/` + WebSocket)
- `npm run build-start`: build e start em sequencia

## Rodar em producao

1. Build:

```bash
npm run build
```

2. Start:

```bash
npm run start
```

3. Defina porta customizada (opcional):

```bash
PORT=8080 npm run start
```

No Windows PowerShell:

```powershell
$env:PORT=8080
npm run start
```

## Estrutura principal

- `index.js`: servidor Node unico (Express + Vite em dev + static em prod + WebSocket)
- `src/App.jsx`: UI do Excalidraw, conexao de sala e sincronizacao da cena
- `src/main.jsx`: bootstrap React
- `src/styles.css`: estilos da aplicacao

## Publicacao

Voce pode publicar esta app Node em qualquer host que suporte Node.js e WebSocket:

- Render
- Railway
- Fly.io
- VPS propria

Checklist de deploy:

1. Instalar dependencias (`npm install`)
2. Build (`npm run build`)
3. Rodar (`npm run start`)
4. Expor a porta (`PORT`) no provedor
5. Garantir suporte a WebSocket no proxy/load balancer

## Troubleshooting

### A porta 5173 ja esta em uso

Defina outra porta:

```powershell
$env:PORT=5174
npm run dev
```

### Usuarios nao sincronizam

- Verifique se ambos estao com o mesmo `room` na URL.
- Verifique se o proxy reverso permite upgrade de WebSocket.
- Verifique logs do servidor para erros de conexao em `/ws`.

### Aviso sobre Vite CJS deprecado

O aviso nao bloqueia a execucao atual. A migracao para ESM pode ser feita depois sem impacto na colaboracao.

## Licenca

Projeto para uso proprio/self-host. Ajuste a licenca conforme sua necessidade.
