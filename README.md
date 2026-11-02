# Emoji Panel para GNOME

Um painel de emoji no estilo do Windows (`Win + .`) para o GNOME Shell no Wayland.

![Emoji Panel aberto sobre a área de trabalho do Ubuntu](docs/screenshot.png)

- **Ctrl + .** abre o painel na hora, perto do cursor de texto
- **Cada clique insere o emoji direto** no app em que você está digitando, e o painel continua aberto
- **Clique fora ou Esc** fecha
- Abas com os emojis usados recentemente e todas as categorias

## Por que uma extensão?

No Wayland, um app comum (Emote, GNOME Characters…) só consegue colar em outra janela saindo da frente dela, então ele fecha a cada emoji ou fica piscando. Este painel roda dentro do próprio GNOME Shell, como o teclado virtual, e nunca rouba o foco do teclado. O emoji vai pelo método de entrada (o mesmo caminho do teclado virtual) e, nos apps que não suportam isso, por um Ctrl+V virtual que devolve sua área de transferência logo depois.

## Instalação

Requer GNOME Shell 46 (Ubuntu 24.04).

```bash
git clone https://github.com/joabzicg/gnome-emoji-panel.git
cd gnome-emoji-panel
./install.sh
```

Depois saia da sessão e entre de novo (no Wayland o GNOME só carrega extensões novas no login).

## Configuração

Trocar o atalho:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/emoji-panel@joab/schemas \
  set org.gnome.shell.extensions.emoji-panel toggle-panel "['<Super>period']"
```

Se outro atalho do sistema também usar `Ctrl + .`, remova-o em Configurações → Teclado → Atalhos de teclado.

## Atualizar a lista de emojis

```bash
curl -O https://unicode.org/Public/emoji/latest/emoji-test.txt
python3 tools/build_emojis.py emoji-test.txt emoji-panel@joab/emojis.json 15.1
```

O último argumento é a versão máxima de emoji que a sua fonte desenha (o Noto Color Emoji do Ubuntu 24.04 vai até a 15.1).

## Licença

GPL-2.0-or-later (veja [LICENSE](LICENSE)). A lista de emojis vem dos dados do Unicode, distribuídos sob a [Unicode License v3](LICENSE-UNICODE.txt).
