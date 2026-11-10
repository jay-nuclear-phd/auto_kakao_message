param([Parameter(Mandatory)][string]$Title, [int]$Last = 0)
# 지정한 제목과 정확히 일치하는 카카오톡 채팅방 창의 대화 내용을 읽어 출력한다 (Ctrl+A, Ctrl+C 방식).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class KR {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
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
$w = [KR]::FindExact($Title)
if ($w -eq [IntPtr]::Zero) { Write-Error "채팅방 창을 찾을 수 없음: $Title (창이 열려 있어야 함)"; exit 1 }
$list = [KR]::FindWindowEx($w, [IntPtr]::Zero, "EVA_VH_ListControl_Dblclk", $null)
if ($list -eq [IntPtr]::Zero) { Write-Error "대화 목록 컨트롤을 찾을 수 없음"; exit 1 }
[void][KR]::ShowWindow($w, 9); [void][KR]::SetForegroundWindow($w)
Start-Sleep -Milliseconds 400
if ([KR]::GetForegroundWindow() -ne $w) { Write-Error "채팅방 창을 앞으로 가져오지 못함 - 중단"; exit 1 }
[KR]::Focus($list)
Start-Sleep -Milliseconds 200
$prevClip = Get-Clipboard -Raw
Set-Clipboard -Value " "
[KR]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
[KR]::keybd_event(0x41,0,0,[UIntPtr]::Zero); [KR]::keybd_event(0x41,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 200
[KR]::keybd_event(0x43,0,0,[UIntPtr]::Zero); [KR]::keybd_event(0x43,0,2,[UIntPtr]::Zero)
[KR]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 600
$t = Get-Clipboard -Raw
if ($prevClip) { Set-Clipboard -Value $prevClip }
$lines = $t -split "`r?`n"
if ($Last -gt 0) { $lines = $lines | Select-Object -Last $Last }
$lines -join "`n"
