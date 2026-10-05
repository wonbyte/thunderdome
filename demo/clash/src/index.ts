import { route } from "./routes.ts";

export default {
  fetch(request: Request): Promise<Response> {
    return route(request);
  },
};
