// 7.0.1に確定・エラー・認識回の印を追加し、stopのPromiseを解決する。
// npm ciのたび同じパッチを当て、対応しない版・変更済みのソースでは止める。
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const base = path.resolve(__dirname, '../node_modules/@capacitor-community/speech-recognition');
if (JSON.parse(fs.readFileSync(path.join(base, 'package.json'))).version !== '7.0.1') throw new Error('Unexpected speech plugin version');
const file = path.join(base, 'android/src/main/java/com/getcapacitor/community/speechrecognition/SpeechRecognition.java');
let source = fs.readFileSync(file, 'utf8');
const marker = '// MAGI: distinguish final results and recognition errors';
const changes = source.includes(marker) ? [] : [
    ['public void onError(int error) {', 'public void onError(int error) {\n            ' + marker + '\n            JSObject event = new JSObject(); event.put("code", error);\n            notifyListeners("recognitionError", event);'],
    ['ret.put("matches", jsArray);', 'ret.put("matches", jsArray);\n                        ret.put("final", true);']
];
changes.push(
    ['stopListening();\n        } catch (Exception ex)', 'stopListening();\n            call.resolve();\n        } catch (Exception ex)'],
    ['event.put("code", error);', 'event.put("code", error); event.put("sessionId", this.call.getString("sessionId", ""));'],
    ['ret.put("final", true);', 'ret.put("final", true);\n                        ret.put("sessionId", this.call.getString("sessionId", ""));'],
    ['ret.put("matches", previousPartialResults);', 'ret.put("matches", previousPartialResults);\n                    ret.put("sessionId", this.call.getString("sessionId", ""));']
);
for (const [from, to] of changes) {
  if (source.includes(to)) continue;
  if (source.split(from).length !== 2) throw new Error('Speech patch no longer matches');
  source = source.replace(from, to);
}
if (source !== fs.readFileSync(file, 'utf8')) fs.writeFileSync(file, source);
console.log('Speech patch: ' + crypto.createHash('sha256').update(source).digest('hex'));
