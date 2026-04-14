# Excalidraw Self-Host (Frontend + Backend no mesmo Node)

Aplicacao de desenho colaborativo em tempo real usando:

- React + Vite no frontend
- Node.js + Express no backend
- WebSocket (`ws`) para sincronizacao de sala

Com esta configuracao, duas ou mais pessoas podem abrir o mesmo link de sala e desenhar juntas ao mesmo tempo. As salas ficam persistidas em disco, entao voce pode voltar depois, navegar entre salas salvas e excluir as que nao quiser mais.

## Requisitos

- Node.js 18+
- npm 9+

## Acesso protegido

O site so abre depois de fazer login com a senha definida no arquivo `.env`.

Variaveis esperadas:

- `APP_PASSWORD`: senha de acesso ao site
- `AUTH_SECRET`: segredo usado para assinar o cookie de sessao; pode ser diferente da senha

O valor da senha nao vai para o bundle do navegador. A validacao acontece no servidor e a sessao fica em cookie `HttpOnly`.

Importante: nao existe forma de esconder do proprio usuario tudo o que ele digita ou troca com o servidor dentro do DevTools do navegador que ele controla. O que esta protegido aqui e o codigo-fonte do app e o acesso sem autenticacao.

## Setup rapido

1. Instale dependencias:

```bash
npm install
```

2. Crie o arquivo `.env` com a senha:

```bash
copy .env.example .env
```

3. Edite `.env` e defina `APP_PASSWORD` e `AUTH_SECRET`

4. Rode em desenvolvimento (frontend + backend juntos):

```bash
npm run dev
```

5. Abra no navegador:

```text
http://localhost:5173
```

## Como usar colaboracao por sala

1. Abra a aplicacao no navegador.
2. Use a sidebar `Salas salvas` para abrir uma sala existente ou clique em `Nova sala`.
3. A sala atual aparece na URL como `?room=...`.
4. Clique em `Copiar link` para compartilhar com outra pessoa.
5. Ambos devem abrir o mesmo link para editar a mesma cena.
6. Para remover uma sala, use o botao `Excluir` na lista.

Exemplo de URL de sala:

```text
http://localhost:5173/?room=abc123xy
```

## Scripts

- `npm run dev`: sobe servidor unico em modo desenvolvimento (Node + Vite middleware + WebSocket)
- `npm run build`: gera build de producao em `dist/`
- `npm run start`: sobe servidor unico em modo producao (serve `dist/` + WebSocket)
- `npm run build-start`: build e start em sequencia

## Persistencia de salas

As salas sao salvas em SQLite no arquivo `data/rooms.db`.

Isso significa que:

- a lista de salas continua disponivel apos reiniciar o servidor
- o conteudo desenhado em cada sala tambem e persistido
- remover uma sala apaga seu registro do banco

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
- `src/App.jsx`: UI do Excalidraw, lista de salas, conexao de sala e sincronizacao da cena
- `src/main.jsx`: bootstrap React
- `src/styles.css`: estilos da aplicacao

## Login e logout

- A tela inicial mostra um formulario de login quando a sessao nao existe.
- O login cria um cookie `HttpOnly` assinado no servidor.
- O botao `Sair` apaga a sessao e volta para a tela de login.

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
