param([Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][string]$TextFile)
# 지정한 제목과 정확히 일치하는 카카오톡 채팅방 창에 텍스트 파일 내용을 전송한다.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class KS {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public static void Focus(IntPtr h){ uint t=GetWindowThreadProcessId(h,IntPtr.Zero); uint me=GetCurrentThreadId(); AttachThreadInput(me,t,true); SetFocus(h); AttachThreadInput(me,t,false); }
  public static IntPtr FindExact(string title){ IntPtr r=IntPtr.Zero; EnumWindows((h,l)=>{
      var c=new StringBuilder(256); GetClassName(h,c,256); if(c.ToString()!="EVA_Window_Dblclk") return true;
      var t=new StringBuilder(512); GetWindowText(h,t,512); if(t.ToString()==title){r=h;return false;} return true;},IntPtr.Zero); return r; }
}
"@
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8).TrimEnd() -replace "`r?`n", "`r`n"
$w = [KS]::FindExact($Title)
if ($w -eq [IntPtr]::Zero) { Write-Error "채팅방 창을 찾을 수 없음: $Title (창이 열려 있어야 함)"; exit 1 }
$edit = [KS]::FindWindowEx($w, [IntPtr]::Zero, "RICHEDIT50W", $null)
if ($edit -eq [IntPtr]::Zero) { Write-Error "입력창을 찾을 수 없음"; exit 1 }
# 백그라운드(작업 스케줄러)에서 실행되면 Windows가 SetForegroundWindow를 막을 수 있어
# Alt 키를 한 번 눌렀다 떼서 포그라운드 잠금을 푼 뒤 시도한다. 최대 3회.
for ($try = 0; $try -lt 3; $try++) {
  [void][KS]::ShowWindow($w, 9)
  [KS]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [KS]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
  [void][KS]::SetForegroundWindow($w)
  Start-Sleep -Milliseconds 500
  if ([KS]::GetForegroundWindow() -eq $w) { break }
}
if ([KS]::GetForegroundWindow() -ne $w) { Write-Error "채팅방 창을 앞으로 가져오지 못함 - 전송 중단"; exit 1 }
[KS]::Focus($edit)
Start-Sleep -Milliseconds 200
$prevClip = Get-Clipboard -Raw
Set-Clipboard -Value $text
Start-Sleep -Milliseconds 200
if ([KS]::GetForegroundWindow() -ne $w) { Write-Error "포커스가 바뀜 - 전송 중단"; exit 1 }
# Ctrl+A (입력창 기존 내용 선택) -> Ctrl+V (붙여넣기)
[KS]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
[KS]::keybd_event(0x41,0,0,[UIntPtr]::Zero); [KS]::keybd_event(0x41,0,2,[UIntPtr]::Zero)
[KS]::keybd_event(0x56,0,0,[UIntPtr]::Zero); [KS]::keybd_event(0x56,0,2,[UIntPtr]::Zero)
[KS]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 500
if ([KS]::GetForegroundWindow() -ne $w) { Write-Error "포커스가 바뀜 - 전송 중단"; exit 1 }
[KS]::keybd_event(0x0D,0,0,[UIntPtr]::Zero); [KS]::keybd_event(0x0D,0,2,[UIntPtr]::Zero)   # Enter
Start-Sleep -Milliseconds 500
if ($prevClip) { Set-Clipboard -Value $prevClip }
"sent to '$Title' (hwnd=$w)"
