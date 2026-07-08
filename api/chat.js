import { handleRequest } from "../server.js";

export const config = {
  maxDuration: 60
};

export default function handler(req, res) {
  return handleRequest(req, res);
}
