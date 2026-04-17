# Documento Consolidado de Desenvolvimento - Jogo Adivinha

Este documento contém todas as informações necessárias para a execução do projeto, unindo regras de negócio, arquitetura técnica e plano de trabalho atualizados.

---

## 1. Visão Geral e Regras de Negócio

O **Adivinha** é um jogo web de perguntas e respostas no estilo Kahoot, focado em conhecimento geral. O jogo oferece duas experiências: um **Modo Geral** para competição global e um **Modo PvP** para confrontos diretos em tempo real.

### Temas e Sistema de Perguntas
- **Temas**: História, Geografia, Português, Filmes e Objetos.
- **Dinâmica**: As perguntas são aleatórias e **não se repetem na mesma partida** para o mesmo jogador.
- **Formato**: Cada pergunta possui 4 alternativas, sendo apenas uma a correta. O jogador só tem uma chance de resposta.
- **Pontuação**: +1 ponto por acerto, 0 pontos por erro.

### Regras de Jogador
- **Nome de Usuário**: Obrigatório, deve ter entre **3 e 12 caracteres**.
- **Exclusividade**: Não são permitidos nomes repetidos no sistema.

---

## 2. Modos de Jogo

### 2.1 Modo Geral (Ranking Global)
Modo individual onde o jogador joga sozinho e disputa posições em um ranking global de todos os jogadores.
- **Tempo**: Fixo de **60 segundos** (não alterável).
- **Limite Diário**: Máximo de **3 partidas por jogador por dia**. O reset ocorre diariamente às 00:00.
- **Fluxo**:
  1. Acessa o site e seleciona "Modo Ranking".
  2. Insere o nome validado.
  3. A partida inicia com o cronômetro de 120s.
  4. Perguntas aparecem automaticamente. Ao responder, mostra Correto/Incorreto e avança. Interface exibe tempo e pontuação.
  5. Fim do tempo: a pergunta atual é descartada.
  6. **Pós-partida**: Pontuação é salva, o ranking global é atualizado e o jogador vê sua posição, pontuação e o Top 10.
- **Critérios do Ranking Global**:
  1. Maior pontuação.
  2. Em caso de empate: Menor tempo de término (timestamp - quem terminou a partida primeiro fica acima).

### 2.2 Modo PvP (Duelo Local via QR Code)
Modo para duas pessoas jogarem uma contra a outra localmente utilizando uma tela principal (Host) e celulares (Players).
- **Capacidade**: Máximo de **2 jogadores**. A partida não inicia com apenas 1.
- **Configuração de Tempo**: O Host define (15s, 30s, 60s ou 120s).
- **Fluxo**:
  1. Host abre o site, escolhe o tempo e gera a sala.
  2. É exibido um **QR Code** com ID único e um contador limite de 60s para entrada.
  3. Os jogadores entram escaneando o QR Code e inserem seus nomes. Não é permitido entrar após o início.
  4. Ao atingir 2 jogadores, um contador de 10s inicia a partida.
  5. **Durante a partida**: Cada jogador responde no seu próprio ritmo (assíncrono). A tela Host exibe a pontuação de ambos em tempo real e o tempo restante.
  6. **Fim da partida**: O tempo acaba, as pontuações finais e o vencedor (ou empate) são exibidos.
- **Nota**: A pontuação de partidas PvP também atualiza o Ranking Global ao final.

---

## 3. Arquitetura Técnica

### Estrutura Base
- `public/index.html`: Interface principal (Lobby, Seleção de Modo, Tela Host PvP, Tela Ranking).
- `public/player.html`: Interface do Jogador (Mobile no PvP ou visualização do Modo Geral).
- `public/style.css`: Design System com visualização premium (Dark mode, glassmorphism, UI responsiva).
- `server.js`: Servidor Node.js responsável por:
  - Rotas e fornecimento dos arquivos estáticos.
  - Sincronização WebSocket (Socket.io) para o Modo PvP.
  - Gerenciamento do Ranking Global e validação do Limite Diário de partidas.
- `questions.txt`: Banco de dados estático de perguntas.

### Backend e Gerenciamento de Estado
- O servidor precisará de um sistema de persistência leve (como arquivos JSON ou SQLite) para salvar o histórico diário de partidas (para a regra de 3 vezes/dia) e o Ranking Global, evitando que os dados se percam ao reiniciar.

---

## 4. Checklist de Desenvolvimento (Roadmap)

### Fase 1: Servidor, Dados e Design Base
- [ ] Definir `style.css` premium (variáveis CSS, tipografia, animações).
- [ ] Criar parser no `server.js` para carregar `questions.txt` na memória.
- [ ] Criar estrutura de banco de dados simples (JSON/SQLite) para Usuários, Partidas e Ranking.

### Fase 2: Modo Geral (Ranking) e Backend
- [ ] Desenvolver frontend do Modo Geral (entrada de nome, tela de jogo).
- [ ] Implementar a lógica de limites diários e verificação de nome único no servidor.
- [ ] Desenvolver fluxo do cronômetro (120s), embaralhamento e descarte de perguntas.
- [ ] Criar o sistema de Ranking Global com o critério de desempate por timestamp.
- [ ] Desenvolver tela do Top 10 e feedback de posição.

### Fase 3: Modo PvP (Sincronização em Tempo Real)
- [ ] Desenvolver tela de criação de sala (Host) e geração de QR Code.
- [ ] Implementar a sala de espera com limite de 60s e trava de entrada.
- [ ] Configurar conexão WebSocket para os jogadores (`player.html`).
- [ ] Sincronizar o countdown de 10s e o início assíncrono das perguntas.
- [ ] Atualizar o placar na tela Host em tempo real via WebSockets.
- [ ] Lógica de vitória/empate e envio da pontuação ao Ranking Global.

### Fase 4: Experiência e Polimento
- [ ] Adicionar feedback tátil (vibração `navigator.vibrate`) no mobile.
- [ ] Implementar animações suaves de transição (Correto/Incorreto).
- [ ] Revisão geral do Clean Code, tratamento de desconexões e segurança básica.
