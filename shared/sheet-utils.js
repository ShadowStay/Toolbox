// Small helpers shared by the character sheet (pages/tabletop.js) and the enemy sheet (pages/tabletop-dm.js).
//   SheetUtils.portrait(file)       -> Promise<data URL>  a square 240 px JPEG cut from the middle of an image file
//   SheetUtils.download(name, doc)  save an object as a .json file
//   SheetUtils.readDoc(file)        -> Promise<object>    read a .json file; an export's {data} wrapper is removed
window.SheetUtils = {
  async portrait(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error("That file could not be read as an image."); }
    const S = 240, c = document.createElement("canvas"), k = Math.max(S / bmp.width, S / bmp.height);
    c.width = c.height = S;
    c.getContext("2d").drawImage(bmp, (S - bmp.width * k) / 2, (S - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    return c.toDataURL("image/jpeg", 0.85);
  },
  download(name, doc) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
    a.download = String(name || "export").replace(/[\\/:*?"<>|]/g, "_") + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  },
  async readDoc(file) {
    let doc;
    try { doc = JSON.parse(await file.text()); } catch { throw new Error("That file is not valid JSON."); }
    return doc && typeof doc.data === "object" ? doc.data : doc;
  },
};
