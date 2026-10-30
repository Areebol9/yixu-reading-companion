param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$Icon)
$ErrorActionPreference = 'Stop'
$taskExecutable = [IO.Path]::GetFullPath($Executable)
$taskIcon = [IO.Path]::GetFullPath($Icon)
if (-not (Test-Path -LiteralPath $taskExecutable -PathType Leaf) -or -not (Test-Path -LiteralPath $taskIcon -PathType Leaf)) { throw 'The executable and application icon must exist.' }
# Update only icon resources. The application manifest, version data, and runtime remain intact.
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-updateresourcew
if (-not ('YixuExecutableIcon' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class YixuExecutableIcon {
    delegate bool NameCallback(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
    delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceNamesW(IntPtr module, IntPtr type, NameCallback callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr parameter);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResourceW(string file, bool deleteExisting);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResourceW(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr update, bool discard);
    class Resource { public int Type; public int Id; public string Name; public ushort Language; }
    static Exception NativeError() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    public static void Apply(string executable, string icon) {
        byte[] ico = File.ReadAllBytes(icon);
        if (ico.Length < 6 || BitConverter.ToUInt16(ico, 0) != 0 || BitConverter.ToUInt16(ico, 2) != 1) throw new InvalidDataException("Invalid ICO header.");
        int count = BitConverter.ToUInt16(ico, 4);
        if (count < 1 || ico.Length < 6 + count * 16) throw new InvalidDataException("Invalid ICO directory.");
        byte[] group = new byte[6 + count * 14];
        Buffer.BlockCopy(ico, 0, group, 0, 6);
        var frames = new List<byte[]>();
        for (int i=0; i<count; i++) {
            int source = 6 + i*16, target = 6 + i*14;
            uint length = BitConverter.ToUInt32(ico, source+8), offset = BitConverter.ToUInt32(ico, source+12);
            if (length == 0 || length > Int32.MaxValue || offset > Int32.MaxValue || (ulong)offset + length > (ulong)ico.Length) throw new InvalidDataException("Invalid ICO image bounds.");
            byte[] frame = new byte[(int)length]; Buffer.BlockCopy(ico, (int)offset, frame, 0, frame.Length); frames.Add(frame);
            Buffer.BlockCopy(ico, source, group, target, 12);
            Buffer.BlockCopy(BitConverter.GetBytes((ushort)(i+1)), 0, group, target+12, 2);
        }
        // Remove every old icon language/group so Explorer cannot select an Electron icon.
        var oldResources = new List<Resource>();
        IntPtr module = LoadLibraryExW(executable, IntPtr.Zero, 0x22);
        if (module == IntPtr.Zero) throw NativeError();
        try {
            foreach (int kind in new int[] {3,14}) {
                NameCallback names = (m,t,n,p) => {
                    bool numeric = (n.ToInt64() >> 16) == 0;
                    int id = numeric ? n.ToInt32() : 0;
                    string text = numeric ? null : Marshal.PtrToStringUni(n);
                    LanguageCallback languages = (lm,lt,ln,language,lp) => { oldResources.Add(new Resource {Type=kind, Id=id, Name=text, Language=language}); return true; };
                    if (!EnumResourceLanguagesW(m,t,n,languages,IntPtr.Zero)) throw NativeError();
                    return true;
                };
                if (!EnumResourceNamesW(module,(IntPtr)kind,names,IntPtr.Zero)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error != 1813) throw new Win32Exception(error);
                }
            }
        } finally { FreeLibrary(module); }
        IntPtr update = BeginUpdateResourceW(executable, false);
        if (update == IntPtr.Zero) throw NativeError();
        try {
            foreach (Resource resource in oldResources) {
                IntPtr name = resource.Name == null ? (IntPtr)resource.Id : Marshal.StringToHGlobalUni(resource.Name);
                try { if (!UpdateResourceW(update,(IntPtr)resource.Type,name,resource.Language,null,0)) throw NativeError(); }
                finally { if (resource.Name != null) Marshal.FreeHGlobal(name); }
            }
            for (int i=0; i<count; i++) if (!UpdateResourceW(update,(IntPtr)3,(IntPtr)(i+1),0,frames[i],(uint)frames[i].Length)) throw NativeError();
            if (!UpdateResourceW(update,(IntPtr)14,(IntPtr)1,0,group,(uint)group.Length)) throw NativeError();
            bool committed = EndUpdateResourceW(update,false); update = IntPtr.Zero;
            if (!committed) throw NativeError();
        } finally { if (update != IntPtr.Zero) EndUpdateResourceW(update,true); }
    }
}
'@
}
[YixuExecutableIcon]::Apply($taskExecutable, $taskIcon)
