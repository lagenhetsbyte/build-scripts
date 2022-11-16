const fs = require("fs");

function replaceImages() {
  try {
    const instructionFile = process.argv[2];
    const instruction = JSON.parse(fs.readFileSync(instructionFile));

    const image = process.argv[3];
    console.log("Replacing service images to:", image);

    instruction.services.forEach((x) => (x.image = image));

    fs.writeFileSync(instructionFile, JSON.stringify(instruction));
  } catch (error) {
    console.log("Failed to replace service image:", error);
    process.exit(1);
  }
}

replaceImages();
