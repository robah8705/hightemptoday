const cities = [
  { city: "Phoenix",        state: "AZ", stid: "KPHX" },
  { city: "Las Vegas",      state: "NV", stid: "KLAS" },
  { city: "Dallas",         state: "TX", stid: "KDFW" },
  { city: "Houston",        state: "TX", stid: "KHOU" },
  { city: "Miami",          state: "FL", stid: "KMIA" },
  { city: "Atlanta",        state: "GA", stid: "KATL" },
  { city: "Los Angeles",    state: "CA", stid: "KLAX" },
  { city: "Chicago",        state: "IL", stid: "KORD" },
  { city: "New York",       state: "NY", stid: "KJFK" },
  { city: "Denver",         state: "CO", stid: "KDEN" },
  { city: "Seattle",        state: "WA", stid: "KSEA" },
  { city: "Boston",         state: "MA", stid: "KBOS" },
  { city: "Minneapolis",    state: "MN", stid: "KMSP" },
  { city: "Nashville",      state: "TN", stid: "KBNA" },
  { city: "Austin",         state: "TX", stid: "KAUS" },
  { city: "San Diego",      state: "CA", stid: "KSAN" },
  { city: "Charlotte",      state: "NC", stid: "KCLT" },
  { city: "Portland",       state: "OR", stid: "KPDX" },
  { city: "Salt Lake City", state: "UT", stid: "KSLC" },
  { city: "Columbus",       state: "OH", stid: "KCMH" },
];

exports.handler = async () => {
  const stids = cities.map(c => c.stid).join(',');
  const token = process.env.SYNOPTIC_TOKEN;
  const url = `https://api.synopticdata.com/v2/stations/latest?stid=${stids}&vars=air_temp&units=temp|F&token=${token}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Synoptic returned ${res.status}`);
    const data = await res.json();
    const stations = data.STATION || [];

    const temps = cities.map(city => {
      const station = stations.find(s => s.STID === city.stid);
      const obs = station?.OBSERVATIONS?.air_temp_value_1;
      return {
        city: city.city,
        state: city.state,
        stid: city.stid,
        temp: obs?.value ? Math.round(obs.value) : null,
        observed_at: obs?.date_time || null,
      };
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ temps, fetched_at: new Date().toISOString() }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
