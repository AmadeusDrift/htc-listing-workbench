using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// Built with the Windows .NET Framework 4 compiler. This process executes no browser-supplied command or path.
internal static class Program {
    const string ExtensionId = "__EXTENSION_ID__";
    const int MaxMessage = 512 * 1024;
    const int MaxPipe = 768 * 1024;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxPipe, RecursionLimit = 40 };
    static readonly Regex Uuid = new Regex(@"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
    static readonly string[] Codes = { "INVALID_MESSAGE", "UNSUPPORTED_VERSION", "UNAUTHORIZED", "TOO_LARGE", "TOO_MANY_SKUS", "INVALID_SOURCE", "INVALID_SNAPSHOT", "CAPTURE_CONFLICT", "APP_UNAVAILABLE", "APP_BUSY", "TIMEOUT", "INTERNAL_ERROR" };
    static readonly string[] Warnings = { "MISSING_TITLE", "MISSING_SKUS", "SKU_STRUCTURE_UNRECOGNIZED", "MISSING_PRICE", "MISSING_IMAGES", "REMOTE_IMAGES_ONLY", "PRICE_PRECISION_UNSUPPORTED", "INCOMPLETE_SKU_IMAGES" };
    sealed class ProtocolException : Exception { public readonly string Code; public ProtocolException(string code) { Code = code; } }
    static Dictionary<string, object> Error(string code, string requestId) { return new Dictionary<string, object> { { "version", 1 }, { "type", "error" }, { "requestId", requestId }, { "ok", false }, { "code", code } }; }
    static string Text(Dictionary<string, object> value, string key) { object result; return value.TryGetValue(key, out result) ? result as string : null; }
    static bool Exact(Dictionary<string, object> value, params string[] keys) { if (value == null || value.Count != keys.Length) return false; foreach (string key in keys) if (!value.ContainsKey(key)) return false; return true; }
    static Dictionary<string, object> Object(string raw) { return Json.DeserializeObject(raw) as Dictionary<string, object>; }
    static bool Version(object value) { return value is int && (int)value == 1; }
    static byte[] ReadExact(Stream stream, int length) { byte[] result = new byte[length]; int offset = 0; while (offset < length) { int count = stream.Read(result, offset, length - offset); if (count == 0) throw new ProtocolException("INVALID_MESSAGE"); offset += count; } return result; }
    static byte[] ReadFrame(Stream stream, int limit) { byte[] header = ReadExact(stream, 4); uint length = BitConverter.ToUInt32(header, 0); if (length > limit) throw new ProtocolException("TOO_LARGE"); if (length == 0) throw new ProtocolException("INVALID_MESSAGE"); return ReadExact(stream, (int)length); }
    static void WriteFrame(Stream stream, object value) { byte[] bytes = Utf8.GetBytes(Json.Serialize(value)); if (bytes.Length > MaxMessage) throw new ProtocolException("TOO_LARGE"); byte[] header = BitConverter.GetBytes(bytes.Length); stream.Write(header, 0, 4); stream.Write(bytes, 0, bytes.Length); stream.Flush(); }
    static string OwnDirectory() { string directory = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar); if (new DirectoryInfo(directory).Name != "collection-connection" || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new ProtocolException("APP_UNAVAILABLE"); return directory; }
    static int SecureDirectory() {
        try {
            string directory = OwnDirectory(); SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
            DirectorySecurity security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false);
            InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
            security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(directory, security); return 0;
        } catch { return 1; }
    }
    static Dictionary<string, object> ReadConfig() {
        try {
            string path = Path.Combine(OwnDirectory(), "connection.json"); FileInfo info = new FileInfo(path);
            if (!info.Exists || info.Length > 4096 || (info.Attributes & FileAttributes.ReparsePoint) != 0) throw new Exception();
            Dictionary<string, object> config = Object(Utf8.GetString(File.ReadAllBytes(path)));
            if (!Exact(config, "version", "pipeName", "token", "extensionId") || !Version(config["version"]) || Text(config, "extensionId") != ExtensionId
                || !Regex.IsMatch(Text(config, "pipeName") ?? "", @"^htc-collection-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$") || !Regex.IsMatch(Text(config, "token") ?? "", @"^[0-9a-f]{64}$")) throw new Exception();
            return config;
        } catch { throw new ProtocolException("APP_UNAVAILABLE"); }
    }
    static Dictionary<string, object> SafeResponse(byte[] bytes, string requestId) {
        Dictionary<string, object> response = Object(Utf8.GetString(bytes));
        if (response == null || !response.ContainsKey("version") || !Version(response["version"])) throw new ProtocolException("INVALID_MESSAGE");
        string type = Text(response, "type");
        if (Text(response, "requestId") != requestId && !(type == "error" && response.ContainsKey("requestId") && response["requestId"] == null)) throw new ProtocolException("INVALID_MESSAGE");
        if (type == "error") { if (!Exact(response, "version", "type", "requestId", "ok", "code") || !(response["ok"] is bool) || (bool)response["ok"] || Array.IndexOf(Codes, Text(response, "code")) < 0) throw new ProtocolException("INVALID_MESSAGE"); }
        else if (type == "status") { if (!Exact(response, "version", "type", "requestId", "ok", "state") || !(response["ok"] is bool) || !(bool)response["ok"] || (Text(response, "state") != "ready" && Text(response, "state") != "paused")) throw new ProtocolException("INVALID_MESSAGE"); }
        else if (type == "receipt") {
            if (!Exact(response, "version", "type", "requestId", "ok", "receipt") || !(response["ok"] is bool) || !(bool)response["ok"]) throw new ProtocolException("INVALID_MESSAGE");
            Dictionary<string, object> receipt = response["receipt"] as Dictionary<string, object>;
            if (!Exact(receipt, "captureId", "receiptId", "productId", "duplicate", "receivedAt", "warnings", "variantCount")) throw new ProtocolException("INVALID_MESSAGE");
            foreach (string key in new string[] { "captureId", "receiptId", "productId" }) if (!Uuid.IsMatch(Text(receipt, key) ?? "")) throw new ProtocolException("INVALID_MESSAGE");
            DateTime date; if (!(receipt["duplicate"] is bool) || !DateTime.TryParseExact(Text(receipt, "receivedAt"), "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out date)
                || !(receipt["variantCount"] is int) || (int)receipt["variantCount"] < 0 || (int)receipt["variantCount"] > 200) throw new ProtocolException("INVALID_MESSAGE");
            object[] warnings = receipt["warnings"] as object[]; if (warnings == null || warnings.Length > Warnings.Length) throw new ProtocolException("INVALID_MESSAGE");
            foreach (object warning in warnings) if (!(warning is string) || Array.IndexOf(Warnings, (string)warning) < 0) throw new ProtocolException("INVALID_MESSAGE");
        } else throw new ProtocolException("INVALID_MESSAGE");
        return response;
    }
    static object Process(string origin) {
        string requestId = null;
        try {
            byte[] message = ReadFrame(Console.OpenStandardInput(), MaxMessage); string raw;
            try { raw = Utf8.GetString(message); Dictionary<string, object> parsed = Object(raw); string candidate = parsed == null ? null : Text(parsed, "requestId"); if (candidate != null && Uuid.IsMatch(candidate)) requestId = candidate; }
            catch { throw new ProtocolException("INVALID_MESSAGE"); }
            Dictionary<string, object> config = ReadConfig();
            byte[] packet = Utf8.GetBytes(Json.Serialize(new Dictionary<string, object> { { "version", 1 }, { "token", Text(config, "token") }, { "origin", origin }, { "payload", Convert.ToBase64String(message) } }));
            if (packet.Length > MaxPipe) throw new ProtocolException("TOO_LARGE");
            using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", Text(config, "pipeName"), PipeDirection.InOut)) {
                try { pipe.Connect(2000); } catch { throw new ProtocolException("APP_UNAVAILABLE"); }
                byte[] header = BitConverter.GetBytes(packet.Length); pipe.Write(header, 0, 4); pipe.Write(packet, 0, packet.Length); pipe.Flush();
                return SafeResponse(ReadFrame(pipe, MaxMessage), requestId);
            }
        } catch (ProtocolException error) { return Error(error.Code, requestId); }
        catch (DecoderFallbackException) { return Error("INVALID_MESSAGE", requestId); }
        catch { return Error("APP_UNAVAILABLE", requestId); }
    }
    public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--secure-local-directory") return SecureDirectory();
        object response;
        if (args.Length < 1 || args.Length > 2 || args[0] != "chrome-extension://" + ExtensionId + "/" || (args.Length == 2 && !Regex.IsMatch(args[1], @"^--parent-window=\d+$"))) response = Error("UNAUTHORIZED", null);
        else {
            object result = null; Thread worker = new Thread(delegate() { result = Process(args[0]); }); worker.IsBackground = true; worker.Start();
            response = worker.Join(10000) ? result : Error("TIMEOUT", null);
        }
        try { WriteFrame(Console.OpenStandardOutput(), response); return 0; } catch { return 1; }
    }
}
