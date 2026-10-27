// Replay the cursor/erase operations emitted by OpenTUI. Acceptance fixtures use
// ASCII text; this is not a general-purpose Unicode terminal emulator.
function terminalScreen(output, rows = 45, columns = 140) {
  const cells = Array.from({ length: rows }, () => Array(columns).fill(" "));
  let row = 0,
    column = 0;
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (ch === "\x1b") {
      if (output[i + 1] === "[") {
        const match = output.slice(i).match(/^\x1b\[([0-9;?=>]*)([ -\/]*)([@-~])/);
        if (!match) continue;
        const args = match[1].split(";").map((x) => Number(x) || 0),
          n = args[0] || 1;
        switch (match[3]) {
          case "H":
          case "f":
            row = Math.min(rows - 1, Math.max(0, (args[0] || 1) - 1));
            column = Math.min(columns - 1, Math.max(0, (args[1] || 1) - 1));
            break;
          case "A":
            row = Math.max(0, row - n);
            break;
          case "B":
            row = Math.min(rows - 1, row + n);
            break;
          case "C":
            column = Math.min(columns - 1, column + n);
            break;
          case "D":
            column = Math.max(0, column - n);
            break;
          case "G":
            column = Math.min(columns - 1, n - 1);
            break;
          case "X":
            cells[row].fill(" ", column, Math.min(columns, column + n));
            break;
          case "K":
            cells[row].fill(" ", args[0] === 1 || args[0] === 2 ? 0 : column, args[0] === 1 ? column + 1 : columns);
            break;
          case "J":
            if (args[0] === 2) for (const line of cells) line.fill(" ");
            break;
        }
        i += match[0].length - 1;
        continue;
      }
      if ("]P_".includes(output[i + 1])) {
        i += 2;
        while (i < output.length && output[i] !== "\x07" && !(output[i] === "\x1b" && output[i + 1] === "\\")) i++;
        if (output[i] === "\x1b") i++;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "\r") {
      column = 0;
      continue;
    }
    if (ch === "\n") {
      row = Math.min(rows - 1, row + 1);
      continue;
    }
    if (ch >= " " && column < columns) cells[row][column++] = ch;
  }
  return cells.map((line) => line.join("")).join("\n");
}
module.exports = { terminalScreen };
