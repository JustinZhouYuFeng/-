const fs = require('fs');
const path = require('path');

function readMarkdownFiles(dirPath) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...readMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push({ path: fullPath, name: entry.name });
    }
  }
  return results;
}

function chunkDocument(filePath, content) {
  const relativePath = path.relative(process.cwd(), filePath);
  const chunks = [];
  const sections = content.split(/\n(?=## )/);

  if (sections.length > 1) {
    sections.forEach((section, idx) => {
      const trimmed = section.trim();
      if (trimmed.length < 10) return;
      chunks.push({
        id: `${relativePath}#section-${idx}`,
        source: relativePath,
        text: trimmed,
        sectionIndex: idx,
      });
    });
  } else {
    const paragraphs = content.split(/\n\n+/);
    let buffer = '';
    let chunkIdx = 0;
    for (const para of paragraphs) {
      buffer += `${buffer ? '\n\n' : ''}${para.trim()}`;
      if (buffer.length >= 200) {
        chunks.push({
          id: `${relativePath}#chunk-${chunkIdx}`,
          source: relativePath,
          text: buffer,
          sectionIndex: chunkIdx,
        });
        buffer = '';
        chunkIdx++;
      }
    }
    if (buffer.trim().length > 10) {
      chunks.push({
        id: `${relativePath}#chunk-${chunkIdx}`,
        source: relativePath,
        text: buffer,
        sectionIndex: chunkIdx,
      });
    }
  }
  return chunks;
}

function loadCorpus(corpusDirs) {
  const allChunks = [];
  for (const dir of corpusDirs) {
    const resolvedDir = path.resolve(dir);
    console.log(`[corpus] 扫描目录: ${resolvedDir}`);
    const files = readMarkdownFiles(resolvedDir);
    for (const file of files) {
      const content = fs.readFileSync(file.path, 'utf-8');
      const chunks = chunkDocument(file.path, content);
      allChunks.push(...chunks);
      console.log(`[corpus]   ${file.name} -> ${chunks.length} chunks`);
    }
  }
  console.log(`[corpus] 总计加载 ${allChunks.length} 个文档片段`);
  return allChunks;
}

module.exports = { loadCorpus };
