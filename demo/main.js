// The bundle the static sample loads in place of public/routes.js (see scripts/build-demo.mjs).
import * as routes from '../public/routes.js';
import { demoFetch, withBase } from './runtime.js';

export const { viewToUrl, urlToView } = withBase(DEMO_BASE, routes);
// This is installed from inside the routes module because the dashboard's own module imports it, so fetch
// answers from the sample before boot() asks for anything, even on the first load.
window.fetch = demoFetch(window.fetch.bind(window), location.origin);
