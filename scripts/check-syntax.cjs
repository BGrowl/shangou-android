const fs = require('fs');
const vm = require('vm');
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');

// 把 E4X 的 ui.layout(<xml/>) 整段替换掉（node 不认 E4X）
const before = src.length;
src = src.replace(/ui\.layout\([\s\S]*?\n\);/g, 'ui.layout(null);');
if (src.length === before) {
  console.log('⚠️  没找到 ui.layout 块，可能是空脚本');
}

try {
  new vm.Script(src, { filename: file });
  console.log('✅ 语法通过（E4X 块已替换后解析）：' + file);
} catch (e) {
  console.log('❌ 语法错误：' + e.message);
  process.exit(1);
}
