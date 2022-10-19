const fs = require("fs");

const instruction = JSON.parse(fs.readFileSync("instruction.json"));

function replaceImages() {
  const image = process.argv[2];
  console.log(image);

  instruction.services.forEach((x) => (x.image = image));
  fs.writeFileSync("instruction.json", JSON.stringify(instruction));
}

replaceImages();
