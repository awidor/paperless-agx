// Synthetic documents for exercising the actual library, search, and page viewers.
export const sampleDocuments = [
  ["Electricity statement", "City Utilities"],
  ["Home insurance renewal", "North Insurance"],
  ["Annual account summary", "Community Bank"],
  ["Internet service invoice", "Connect Telecom"],
  ["Rental agreement", "Oak Property Services"],
  ["September payslip", "Studio Works"],
  ["Order confirmation", "Office Supply Co."],
  ["Heating service report", "Local Heating"],
].map(([title, sender], index) => ({
  document_id: index + 1, title, sender, filename: `document-${index + 1}.png`,
  added_at: `2026-09-0${8 - index}T12:00:00Z`, created_at: null,
  file_size: 123000 + index * 21000, status: "READY", page_count: 1, media_type: "image",
}));

export function samplePage(document = sampleDocuments[0]) {
  return {
    page: 1, thumbnail_ready: true,
    blocks: [{ label: "Text", bbox: [100, 100, 900, 140], text: document.title }],
    html: `
      <div data-bbox="100 55 900 80" data-label="Caption">${document.sender}</div>
      <div data-bbox="100 110 900 150" data-label="Title">${document.title}</div>
      <div data-bbox="100 190 500 250" data-label="Text">Alex Morgan<br>42 Garden Street<br>10115 Berlin</div>
      <div data-bbox="100 320 900 365" data-label="Text">Please find your statement for the current billing period below. Your account details and payment information are included for your records.</div>
      <div data-bbox="100 415 900 470" data-label="Table"><table><tr><td>Service charge</td><td>64.00 EUR</td></tr><tr><td>Usage</td><td>38.50 EUR</td></tr><tr><td>Total due</td><td>102.50 EUR</td></tr></table></div>
      <div data-bbox="100 530 900 550" data-label="Text">Payment due by 30 September 2026.</div>
      <div data-bbox="100 860 900 880" data-label="Page-footer">${document.sender} · Customer services · Page 1 of 1</div>`,
  };
}

export function pageImage(document = sampleDocuments[0]) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
    <rect width="600" height="800" fill="white"/>
    <g fill="#242424" font-family="Arial, sans-serif">
      <text x="60" y="62" font-size="14" font-weight="bold">${document.sender}</text>
      <text x="60" y="113" font-size="23">${document.title}</text>
      <g font-size="11"><text x="60" y="165">Alex Morgan</text><text x="60" y="182">42 Garden Street</text><text x="60" y="199">10115 Berlin</text>
      <text x="60" y="272">Please find your statement for the current billing period below.</text>
      <text x="60" y="289">Your account details and payment information are included for your records.</text>
      <text x="60" y="352">Service charge</text><text x="458" y="352">64.00 EUR</text>
      <text x="60" y="382">Usage</text><text x="458" y="382">38.50 EUR</text>
      <text x="60" y="424" font-weight="bold">Total due</text><text x="450" y="424" font-weight="bold">102.50 EUR</text>
      <text x="60" y="480">Payment due by 30 September 2026.</text></g>
      <text x="60" y="713" font-size="9">${document.sender} · Customer services</text>
      <text x="480" y="713" font-size="9">Page 1 of 1</text>
    </g>
    <path d="M60 84H540 M60 326H540 M60 400H540 M60 447H540 M60 690H540" stroke="#cccccc"/>
  </svg>`;
}

// A real, single-page PDF with selectable text; offsets are calculated from ASCII bytes.
export function samplePdf(): Buffer {
  const stream = "BT /F1 22 Tf 60 710 Td (Electricity statement) Tj 0 -60 Td /F1 12 Tf (Payment due by 30 September 2026.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
