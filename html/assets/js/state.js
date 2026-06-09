const state = {
  token: null,
  user: null,
  activeView: "dashboard",
  activeCleanup: null,
  /** Currently selected workspace (network ID). null = "All Resources". */
  activeWorkspace: null,
  /** Cached network list for workspace selector. */
  networks: [],
};

export default state;
