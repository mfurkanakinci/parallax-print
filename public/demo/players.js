// Starting a clip pauses the others, including the narrated walkthrough.
const players = [...document.querySelectorAll('video')];
for (const player of players) {
  player.addEventListener('play', () => {
    for (const other of players) if (other !== player) other.pause();
  });
}
