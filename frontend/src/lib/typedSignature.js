/**
 * Draw a typed signature (or initials) in a cursive font onto a canvas sized to
 * fit it, and return the PNG data URL.
 *
 * The sign page used a fixed 700×160 canvas with the name centred at 72px, so a
 * long name ran off both edges and was cut: "Vaibhav Chandrashekhar Pradhan"
 * (30 characters) signed as "ibhav Chandrashekhar Prad". Two of the 19 typed
 * signatures on file were cut; the longest uncut one was 20 characters. Now the
 * canvas grows to the measured ink width (cursive capitals overhang their
 * advance width, so the real bounding box is used, not just `width`). The PDF
 * stamper scales the image into the signature box keeping its proportions, so
 * a wider image lands smaller, never cropped.
 */
export function renderCursivePng(text, {
  font,
  size = 72,
  minWidth = 700,
  height = 160,
  pad = 24,
  createCanvas = () => document.createElement('canvas'),
} = {}) {
  const canvas = createCanvas();
  const fontSpec = `${size}px '${font}', cursive`;

  // Measure first: changing a canvas's size resets its context state.
  let g = canvas.getContext('2d');
  g.font = fontSpec;
  g.textAlign = 'left';
  const m = g.measureText(text);
  const left = Math.max(0, Number(m.actualBoundingBoxLeft) || 0);
  const right = Math.max(Number(m.actualBoundingBoxRight) || 0, Number(m.width) || 0);
  const inkWidth = Math.ceil(left + right);

  canvas.width = Math.max(minWidth, inkWidth + pad * 2);
  canvas.height = height;
  g = canvas.getContext('2d');
  // Transparent background — strokes land naturally on the lease PDF.
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#222';
  g.font = fontSpec;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  // Centre the ink, not the advance box.
  const x = (canvas.width - inkWidth) / 2 + left;
  g.fillText(text, x, canvas.height / 2);
  return canvas.toDataURL('image/png');
}
