const readline = require("node:readline");
const pty = require(process.argv[2]);
const terminal = pty.spawn(process.argv[3], process.argv.slice(4), {
  cwd: process.cwd(),
  env: process.env,
  name: "xterm-256color",
  cols: 140,
  rows: 45,
});
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
terminal.onData((data) => send({ data }));
terminal.onExit((result) => {
  send({ exit: result });
  process.exit(0);
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.write !== undefined) terminal.write(command.write);
  if (command.kill) terminal.kill();
});
