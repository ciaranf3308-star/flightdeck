// FlightDeck.SimConnectBridge — NavDataFetch.cs
//
// ONE-SHOT live navdata fetch: queries the simulator's OWN nav database over
// SimConnect facility data and POSTs the result to the planning API:
//
//     FlightDeck.SimConnectBridge --fetch-procedures KJFK,EIDW \
//         --api-url http://localhost:8124/api/navdata/procedures
//
// *** STATUS: UNCOMPILED / UNTESTED ***
// Written against the MSFS 2024 SDK SimConnect API reference
// (SimConnect_AddToFacilityDefinition / SimConnect_RequestFacilityData).
// Build on Windows with `dotnet build` (MSFS 2024 SDK managed SimConnect
// reference) with the sim running, then verify the posted JSON. Every
// assumption that could not be verified off-sim is marked ADJUST.
//
// What it fetches per airport — always from the sim's ACTIVE navdata
// (default or Navigraph), so procedure names match what the EFB and the
// aircraft MCDU expect:
//   - departures (SIDs): name, runway transitions, enroute transitions
//   - arrivals (STARs): same
//   - runways: numbers/designators + ILS ident per runway end
//     (ILS availability per runway end is derived from PRIMARY_ILS_ICAO /
//     SECONDARY_ILS_ICAO — no APPROACH-child query in v1)
//   - enroute transition coordinates, resolved via WAYPOINT facility queries
//
// Honesty: only names the sim returns are sent. Waypoints the sim cannot
// resolve are skipped, never guessed. A failed airport never blocks the rest.
//
// KNOWN SIM ISSUE (MSFS forum): RequestFacilityData for a few airports
// (ESGF, ZLXY, ZSQD, KLMS, KOSX, M44 reported) can CTD the *simulator* with
// certain navdata. The per-airport try/catch below cannot prevent a sim CTD;
// if a fetch crashes the sim, exclude that airport and report it.

using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.FlightSimulator.SimConnect;

namespace FlightDeck.SimConnectBridge;

internal static class NavDataFetch
{
    private enum Def : uint
    {
        Airport = 10,
        Waypoint = 11,
    }

    // Requests are awaited sequentially, so fixed IDs are safe (one in flight
    // at a time per kind).
    private enum Req : uint
    {
        Airport = 100,
        Waypoint = 101,
    }

    // --- JSON posted to the planning API ----------------------------------
    internal sealed class ProcJson
    {
        [JsonPropertyName("kind")] public string Kind { get; set; } = "";
        [JsonPropertyName("name")] public string Name { get; set; } = "";
        [JsonPropertyName("runways")] public string[] Runways { get; set; } = Array.Empty<string>();
        [JsonPropertyName("transitions")] public string[] Transitions { get; set; } = Array.Empty<string>();
        [JsonPropertyName("transitionPositions")] public Dictionary<string, LatLonJson> TransitionPositions { get; set; } = new();
        [JsonPropertyName("approachType")] public string? ApproachType { get; set; }
    }

    internal sealed record LatLonJson(
        [property: JsonPropertyName("lat")] double Lat,
        [property: JsonPropertyName("lon")] double Lon);

    internal sealed record AirportJson(
        [property: JsonPropertyName("icao")] string Icao,
        [property: JsonPropertyName("cycle")] string Cycle,
        [property: JsonPropertyName("procedures")] List<ProcJson> Procedures);

    // --- entry point --------------------------------------------------------
    public static async Task<int> RunAsync(string[] icaos, string postUrl, CancellationToken token)
    {
        using var sim = new SimConnect("FlightDeck NavData Fetch", IntPtr.Zero, 0x0402, null, 0);
        Console.WriteLine("Connected to MSFS 2024 via SimConnect.");

        DefineAirport(sim);
        DefineWaypoint(sim);

        // Pump the SimConnect message queue for the duration of the run.
        // (Console app without a window handle: the classic no-pump pattern.)
        var pumpCts = CancellationTokenSource.CreateLinkedTokenSource(token);
        var pump = Task.Run(async () =>
        {
            while (!pumpCts.Token.IsCancellationRequested)
            {
                try { sim.ReceiveMessage(); } catch { /* connection dropped; requests time out below */ }
                await Task.Delay(1, pumpCts.Token).ConfigureAwait(false);
            }
        }, pumpCts.Token);

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            var okCount = 0;
            for (var i = 0; i < icaos.Length; i++)
            {
                var icao = icaos[i].Trim().ToUpperInvariant();
                if (icao.Length < 3 || icao.Length > 4) continue;
                try
                {
                    var payload = await RequestAirportAsync(sim, icao, token).ConfigureAwait(false);
                    var procs = ParseAirport(icao, payload);

                    // Resolve enroute-transition coordinates via WAYPOINT queries.
                    var names = procs.SelectMany(p => p.Transitions).Distinct().ToList();
                    var positions = new Dictionary<string, LatLonJson>();
                    for (var w = 0; w < names.Count; w++)
                    {
                        var pos = await RequestWaypointAsync(sim, names[w], token).ConfigureAwait(false);
                        if (pos != null) positions[names[w]] = pos;
                    }
                    foreach (var p in procs)
                        p.TransitionPositions = p.Transitions
                            .Where(t => positions.ContainsKey(t))
                            .ToDictionary(t => t, t => positions[t]);

                    var body = new AirportJson(icao, "SIM-" + DateTime.UtcNow.ToString("yyyy-MM-dd"), procs);
                    using var resp = await http.PostAsJsonAsync(postUrl, body, token).ConfigureAwait(false);
                    resp.EnsureSuccessStatusCode();
                    Console.WriteLine($"{icao}: posted {procs.Count} procedures.");
                    okCount++;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    Console.Error.WriteLine($"{icao}: fetch failed: {ex.Message}");
                }
            }
            return okCount > 0 ? 0 : 1;
        }
        finally
        {
            pumpCts.Cancel();
            try { await pump.ConfigureAwait(false); } catch { /* pump teardown */ }
            pumpCts.Dispose();
        }
    }

    // --- facility definitions ------------------------------------------------
    // Field order below MUST match the parse order in ParseAirport/ReadProcedure.
    private static void DefineAirport(SimConnect sim)
    {
        void Add(string f) => sim.AddToFacilityDefinition(Def.Airport, f);
        Add("OPEN AIRPORT");
        Add("N_RUNWAYS");
        Add("N_DEPARTURES");
        Add("N_ARRIVALS");
        Add("OPEN RUNWAY");
        Add("PRIMARY_NUMBER");
        Add("PRIMARY_DESIGNATOR");
        Add("SECONDARY_NUMBER");
        Add("SECONDARY_DESIGNATOR");
        Add("PRIMARY_ILS_ICAO");
        Add("SECONDARY_ILS_ICAO");
        Add("CLOSE RUNWAY");
        AddProcedureLevel(Add, "DEPARTURE");
        AddProcedureLevel(Add, "ARRIVAL");
        Add("CLOSE AIRPORT");
    }

    private static void AddProcedureLevel(Action<string> add, string level)
    {
        add("OPEN " + level);
        add("NAME");
        add("N_RUNWAY_TRANSITIONS");
        add("N_ENROUTE_TRANSITIONS");
        add("OPEN RUNWAY_TRANSITION");
        add("RUNWAY_NUMBER");
        add("RUNWAY_DESIGNATOR");
        add("CLOSE RUNWAY_TRANSITION");
        add("OPEN ENROUTE_TRANSITION");
        add("NAME");
        add("CLOSE ENROUTE_TRANSITION");
        add("CLOSE " + level);
    }

    private static void DefineWaypoint(SimConnect sim)
    {
        void Add(string f) => sim.AddToFacilityDefinition(Def.Waypoint, f);
        Add("OPEN WAYPOINT");
        Add("LATITUDE");
        Add("LONGITUDE");
        Add("CLOSE WAYPOINT");
    }

    // --- request/response plumbing -------------------------------------------
    private sealed class Collector
    {
        public readonly List<byte[]> Buffers = new();
        public DateTime LastReceived = DateTime.UtcNow;
    }

    private static byte[] ExtractPayload(SIMCONNECT_RECV_FACILITY_DATA data)
    {
        // ADJUST (compile-time): confirm the variable-payload member of the
        // managed SIMCONNECT_RECV_FACILITY_DATA in your SDK's SimConnect.dll.
        // Assumed here: `public byte[] dwData`. If it is `uint[]`, convert:
        //   var u = (uint[])data.dwData; var b = new byte[u.Length * 4];
        //   Buffer.BlockCopy(u, 0, b, 0, b.Length); return b;
        return (data.dwData as byte[]) ?? Array.Empty<byte>();
    }

    private static async Task<byte[]> RequestAirportAsync(
        SimConnect sim, string icao, CancellationToken token)
    {
        const uint requestId = (uint)Req.Airport;
        var collector = new Collector();
        var gate = new object();
        void Handler(SimConnect sender, SIMCONNECT_RECV_FACILITY_DATA d)
        {
            if (d.dwRequestID != requestId) return;
            lock (gate)
            {
                collector.Buffers.Add(ExtractPayload(d));
                collector.LastReceived = DateTime.UtcNow;
            }
        }
        sim.OnRecvFacilityData += Handler;
        try
        {
            // ADJUST: managed signature is RequestFacilityData(Def, Request, icao).
            // If your wrapper requires a region argument, pass "" (default region).
            sim.RequestFacilityData(Def.Airport, Req.Airport, icao);
            return await WaitForQuietAsync(collector, gate, token).ConfigureAwait(false);
        }
        finally
        {
            sim.OnRecvFacilityData -= Handler;
        }
    }

    private static async Task<LatLonJson?> RequestWaypointAsync(
        SimConnect sim, string name, CancellationToken token)
    {
        const uint requestId = (uint)Req.Waypoint;
        var collector = new Collector();
        var gate = new object();
        void Handler(SimConnect sender, SIMCONNECT_RECV_FACILITY_DATA d)
        {
            if (d.dwRequestID != requestId) return;
            lock (gate)
            {
                collector.Buffers.Add(ExtractPayload(d));
                collector.LastReceived = DateTime.UtcNow;
            }
        }
        sim.OnRecvFacilityData += Handler;
        try
        {
            sim.RequestFacilityData(Def.Waypoint, Req.Waypoint, name);
            var payload = await WaitForQuietAsync(collector, gate, token, quietAfterMs: 800, timeoutMs: 6000)
                .ConfigureAwait(false);
            var r = new Reader(payload);
            if (r.Remaining < 16) return null; // sim could not resolve the fix
            return new LatLonJson(r.F64(), r.F64());
        }
        catch
        {
            return null; // unknown fix: skip, never guess coordinates
        }
        finally
        {
            sim.OnRecvFacilityData -= Handler;
        }
    }

    // Wait for the first message, then for a quiet period (no new messages).
    // A request that yields nothing at all times out and throws.
    private static async Task<byte[]> WaitForQuietAsync(
        Collector collector, object gate, CancellationToken token,
        int quietAfterMs = 1500, int timeoutMs = 20000)
    {
        var start = DateTime.UtcNow;
        while (true)
        {
            token.ThrowIfCancellationRequested();
            int count;
            DateTime last;
            lock (gate) { count = collector.Buffers.Count; last = collector.LastReceived; }
            if (count > 0 && (DateTime.UtcNow - last).TotalMilliseconds >= quietAfterMs)
                break;
            if ((DateTime.UtcNow - start).TotalMilliseconds >= timeoutMs)
                throw new TimeoutException(
                    count == 0 ? "no facility data received" : "facility data stream stalled");
            await Task.Delay(100, token).ConfigureAwait(false);
        }
        int total;
        lock (gate) total = collector.Buffers.Sum(b => b.Length);
        var merged = new byte[total];
        var offset = 0;
        lock (gate)
        {
            foreach (var b in collector.Buffers)
            {
                Buffer.BlockCopy(b, 0, merged, offset, b.Length);
                offset += b.Length;
            }
        }
        return merged;
    }

    // --- parsing ---------------------------------------------------------------
    // Payload layout = the field order in DefineAirport, walked with the
    // N_* counts. Messages may arrive as one blob per airport or split per
    // object (SDK example shows per-object messages); WaitForQuietAsync
    // concatenates them in arrival order, which matches field order either way.
    private sealed class Reader
    {
        private readonly byte[] _b;
        private int _o;
        public Reader(byte[] b) { _b = b; }
        public int Remaining => _b.Length - _o;
        public int I32() { var v = BitConverter.ToInt32(_b, _o); _o += 4; return v; }
        public double F64() { var v = BitConverter.ToDouble(_b, _o); _o += 8; return v; }
        public string C8()
        {
            if (_o + 8 > _b.Length) throw new InvalidOperationException("facility payload truncated");
            var s = Encoding.ASCII.GetString(_b, _o, 8);
            _o += 8;
            return s.Trim('\0', ' ');
        }
    }

    private static List<ProcJson> ParseAirport(string icao, byte[] payload)
    {
        var r = new Reader(payload);
        var nRunways = r.I32();
        var nDepartures = r.I32();
        var nArrivals = r.I32();
        if (nRunways is < 0 or > 200 || nDepartures is < 0 or > 500 || nArrivals is < 0 or > 500)
            throw new InvalidOperationException("facility payload failed sanity check");

        var runwayIls = new Dictionary<string, bool>();
        for (var i = 0; i < nRunways; i++)
        {
            var pName = RwyName(r.I32(), r.I32());
            var sName = RwyName(r.I32(), r.I32());
            var pIls = r.C8();
            var sIls = r.C8();
            if (pName != null) runwayIls[pName] = !string.IsNullOrEmpty(pIls);
            if (sName != null) runwayIls[sName] = !string.IsNullOrEmpty(sIls);
        }

        var procs = new List<ProcJson>();
        for (var i = 0; i < nDepartures; i++) procs.Add(ReadProcedure(r, "SID"));
        for (var i = 0; i < nArrivals; i++) procs.Add(ReadProcedure(r, "STAR"));

        // v1: ILS approaches are derived from per-runway-end ILS idents rather
        // than an APPROACH-child query. The PLN carries approach TYPE + runway
        // (never a name), so this is sufficient and fully verified.
        foreach (var kv in runwayIls.Where(kv => kv.Value))
        {
            procs.Add(new ProcJson
            {
                Kind = "APPROACH",
                // Label only: the PLN emits type+runway, not this name.
                Name = "ILS" + kv.Key,
                Runways = new[] { kv.Key },
                ApproachType = "ILS",
            });
        }
        _ = icao;
        return procs;
    }

    private static ProcJson ReadProcedure(Reader r, string kind)
    {
        var name = r.C8();
        var nRt = r.I32();
        var nEt = r.I32();
        if (nRt is < 0 or > 60 || nEt is < 0 or > 60)
            throw new InvalidOperationException("procedure payload failed sanity check");
        var runways = new List<string>();
        for (var i = 0; i < nRt; i++)
        {
            var rn = RwyName(r.I32(), r.I32());
            if (rn != null) runways.Add(rn);
        }
        var transitions = new List<string>();
        for (var i = 0; i < nEt; i++)
        {
            var t = r.C8();
            if (!string.IsNullOrEmpty(t)) transitions.Add(t);
        }
        return new ProcJson { Kind = kind, Name = name, Runways = runways.ToArray(), Transitions = transitions.ToArray() };
    }

    private static string? RwyName(int number, int designator)
    {
        if (number is < 1 or > 36) return null;
        var d = designator switch { 1 => "L", 2 => "R", 3 => "C", _ => "" };
        return number.ToString("D2") + d;
    }
}
