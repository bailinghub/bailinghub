import JSZip from 'jszip';

export async function makeDocxFixture({ empty = false } = {}) {
  const zip = new JSZip();
  const body = empty ? '' : `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>中文核对报告</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">第一段  保留空格</w:t><w:tab/><w:t>制表符</w:t><w:br/><w:t>换行 %.101f %.101e %.101g</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>列表项目</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>订单</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>已核对</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:hyperlink r:id="link"><w:r><w:t>参考链接</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="image" descr="流程图"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}<w:sectPr/></w:body></w:document>`);
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>');
  zip.file('word/numbering.xml', '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>');
  zip.file('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/reference" TargetMode="External"/><Relationship Id="image" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image.png"/></Relationships>');
  zip.file('word/media/image.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6XkAAAAASUVORK5CYII=', 'base64'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
