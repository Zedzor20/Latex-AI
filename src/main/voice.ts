import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech -ErrorAction Stop
$recognizer = $null
# Prefer the default recognizer (any installed language), then en-US.
try {
  $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine
} catch {
  try {
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine('en-US')
  } catch {
    Write-Output '{"error":"No speech recognizer is installed on this Windows system. Install Windows Speech Recognition or a language pack, or use the Windows 11 voice typing feature."}'
    exit 1
  }
}
try {
  $recognizer.SetInputToDefaultAudioDevice()
} catch {
  Write-Output '{"error":"No microphone was detected. Check that a microphone is connected and enabled."}'
  exit 1
}
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$recognizer.LoadGrammar($grammar)
$result = $null
try {
  $result = $recognizer.Recognize(10)
} catch {
  Write-Output '{"error":"Microphone permission was denied or speech recognition failed to start."}'
  exit 1
}
if ($null -eq $result) {
  Write-Output '{"error":"No speech was recognized. Try again and speak clearly into the microphone."}'
  exit 1
}
$text = $result.Text
if ([string]::IsNullOrWhiteSpace($text)) {
  Write-Output '{"error":"No speech was recognized. Try again and speak clearly into the microphone."}'
  exit 1
}
Write-Output ('{"text":' + (ConvertTo-Json -InputObject $text.Trim()) + '}')
exit 0
`;

/**
 * Transcribe one utterance of speech using the Windows built-in speech
 * recognizer (System.Speech). No API key, no network — the reliable path for
 * Electron, whose Chromium ships without the Web Speech API.
 *
 * Returns { text } on success. Throws a friendly error when the recognizer
 * is unavailable or nothing intelligible was heard.
 */
export async function transcribeMicrophone(timeoutMs = 12000, lang?: string): Promise<{ text: string }> {
  const scriptPath = path.join(os.tmpdir(), `latex-voice-${Date.now()}.ps1`);
  // Map language codes to Windows culture names for System.Speech
  const cultureMap: Record<string, string> = {
    "hi-IN": "hi-IN",   // Hindi
    "ur-PK": "ur-PK",   // Urdu
    "hi": "hi-IN",
    "ur": "ur-PK",
    "auto": "",
    "en-US": "en-US",
    "en": "en-US"
  };
  const culture = cultureMap[lang ?? ""] ?? "";
  // Replace the default recognizer culture in the script if a specific language is requested.
  const effectiveScript = culture
    ? SCRIPT.replace(
        /New-Object System\.Speech\.Recognition\.SpeechRecognitionEngine\b/g,
        `New-Object System.Speech.Recognition.SpeechRecognitionEngine('${culture}')`
      )
    : SCRIPT;
  await fs.promises.writeFile(scriptPath, effectiveScript, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { timeout: timeoutMs + 5000, windowsHide: true }
    );
    // stdout may include PowerShell progress noise; take the last JSON line.
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"));
    const lastLine = lines[lines.length - 1];
    if (!lastLine) throw new Error("No speech was recognized. Try again.");
    let parsed: { text?: string; error?: string };
    try {
      parsed = JSON.parse(lastLine) as { text?: string; error?: string };
    } catch {
      throw new Error("Speech recognition returned an unexpected result.");
    }
    if (parsed.error) throw new Error(parsed.error);
    if (!parsed.text) throw new Error("No speech was recognized. Try again.");
    return { text: parsed.text };
  } finally {
    fs.promises.unlink(scriptPath).catch(() => undefined);
  }
}
