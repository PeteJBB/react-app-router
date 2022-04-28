import React from 'react';
import Analytics from '../services/Analytics';
import SafeComponent from './SafeComponent';
import NanoRouter from 'nanorouter';
import RouteConfig from '../RouteConfig';
import { createBrowserHistory } from 'history';
import NotFoundErrorScreen from './NotFoundErrorScreen';
import OfflineErrorScreen from './OfflineErrorScreen';
import UnknownErrorScreen from './UnknownErrorScreen';
import AppLoadingScreen from './AppLoadingScreen';
import Session, { Events } from '../services/Session';
import DialogManager from './DialogManager';
import AppState from '../services/AppState';
import Evented from '../utils/Evented';
import {
    NetworkFailedError,
    RoutePathError,
    SessionTimeoutError
} from '../Errors';

const history = createBrowserHistory();
const _evented = new Evented();

export default class AppRouter extends SafeComponent
{
    static instance;

    // keep track of last query params seen for each route
    static queryParams = {};

    router = new NanoRouter({ default: '/404' });

    state = {
        routeStack: null,
        currentRoute: null,
        params: null,
        error: null,
        currentTransition: null,
    }

    constructor() {
        super();
        this.initRoutes(RouteConfig);
        AppRouter.instance = this;
    }

    onMount() {
        Session.on(Events.IsAuthenticatedChanged, this, this.isAuthenticated_changed);
        Session.restore();
    }

    isAuthenticated_changed(isAuthed) {
        if(isAuthed) {
            // user just logged in, reload current path
            AppRouter.refresh();
        }
        else {
            // user has just landed in or refreshed the app but has no token
            // display login page (url will remain the same)
            this.router.emit('/login');
        }
    }

    initRoutes(routes, parentRoute = null, pathSoFar = '') {
        // in case this runs a second time (can happen if app crashes on startup)
        // filter out any routes which have already been init'd
        let uninitedRoutes = routes.filter(r => !Object.isFrozen(r));
        uninitedRoutes.forEach(r => {
            // update route with ref to parent
            // and inherit paramTypes
            if (parentRoute) {
                r.parentRoute = parentRoute;
                r.paramTypes = {
                    ...parentRoute.paramTypes,
                    ...(r.paramTypes || {})
                };
            }

            let path = pathSoFar + r.path;
            this.router.on(path, (params) => {
                this.transitionToRoute(r, params);
            });

            if(r.routes) {
                this.initRoutes(r.routes, r, path);
            }

            // freeze object once its been init'd to prevent meddling
            Object.freeze(r);
        });
    }

    transitionToRoute(route, params) {
        // if user is not signed in just display the login screen
        if(!Session.isAuthenticated && route.path !== '/login') {
            this.router.emit('/login');
            return;
        }

        // if user just logged in and they are being sent to the HomeRoute
        // look for their last-used store and send them there instead
        if(AppState.justLoggedIn && route.path === '/') {
            let shopId = localStorage.getItem(`user${Session.userId}_shopId`);
            if(shopId) {
                AppRouter.replaceWith(`/stores/${shopId}`);
                return;
            }
        }

        let oldRouteStack = this.state.routeStack || [];
        let newRouteStack = this.buildRouteStack(route, params);

        // cancel any other transition that might be running
        if(this.state.currentTransition) {
            this.state.currentTransition.cancel = true;
        }

        // create a new transition object
        // this is essentially a wrapper for promises that can be cancelled
        let transition = {
            cancel: false,
            promise: Promise.resolve(),
            oldRouteStack,
            newRouteStack,
        };

        // loop through the route tree
        // calling fetch on each one and letting them complete in order
        newRouteStack.forEach(r => {
            let prevEntry = oldRouteStack.findBy('route', r.route);
            // use previous data if params haven't changed
            if(prevEntry && compareParams(prevEntry.params, r.params)) {
                r.data = prevEntry.data;
            }
            else {
                let fetchData = r.route.component.fetchData;
                if(typeof fetchData === 'function') {
                    transition.promise = transition.promise.then(() => {
                        if(!transition.cancel) {
                            return fetchData(r.params).then(data => {
                                // store the result of fetch on the route object
                                r.data = data;
                            });
                        }
                    });
                }
            }
        });

        transition.promise.then(() => {
            if(!transition.cancel) {
                Analytics.pageView();

                this.setState({
                    routeStack: newRouteStack,
                    currentRoute: route,
                    error: null,
                });
            }
        })
        .catch(e => {
            let error = null;

            // ignore timeout errors...
            if (!(e instanceof SessionTimeoutError)) {
                AppState.logError(e);
                error = e;
            }

            this.setState({
                routeStack: null,
                currentRoute: null,
                error,
            });
        });

        // unless this is initial load or login, show spinner during route transition
        if(this.state.currentRoute && this.state.currentRoute.path !== '/login') {
            DialogManager.showLoading(transition.promise);
        }

        this.state.currentTransition = transition;
        return transition;
    }

    /**
     * map a router param using paramTypes set up on RouteConfig
     * Otherwise all params come in as strings which cause headaches for comparisons later
    */
    mapParam(key, val, route) {
        let type = route.paramTypes[key];
        switch(type) {
            case 'number':
                return parseFloat(val);
            // TODO - more types?
            default:
                return val;
        }
    }

    /** Map all the router params using paramTypes **/
    mapParams(route, allParams) {
        let params = {};
        Object.keys(allParams).forEach(key => {
            if(route.path.indexOf(`:${key}`) > -1) {
                params[key] = this.mapParam(key, allParams[key], route);
            }
        });
        return params;
    }

    /** traverse the route tree upwards, and build an array of the currently active routes */
    buildRouteStack(leafRoute, allParams) {
        let stack = [];
        let r = leafRoute;

        while(r) {
            let params = this.mapParams(r, allParams);

            // create a new RouteInfo object and put in stack
            let routeInfo = {
                route: r,
                params,
                data: null, // filled in later
            };
            stack.unshift(routeInfo);
            r = r.parentRoute;
        }

        return stack;
    }

    render() {
        let err = this.state.error;
        if(err && err instanceof RoutePathError) {
            return <NotFoundErrorScreen error={err} />;
        }
        if(err && err instanceof NetworkFailedError) {
            return <OfflineErrorScreen error={err} />;
        }
        if(err) {
            return <UnknownErrorScreen error={err} />;
        }

        if(!this.state.routeStack) {
            // this happens before initial fetch has completed
            // display loading screen
            return <AppLoadingScreen />;
        }

        // render the top-level route
        // child routes will be rendered within each route by calling outlet()
        return this.renderRoute(this.state.routeStack[0]);
    }

    renderRoute(routeInfo) {
        if(!routeInfo) {
            return null;
        }

        let Component = routeInfo.route.component;
        let params = this.state.params;
        return (
            <Component
                {...params}
                routeInfo={routeInfo}
            />
        );
    }

    static navigateBack() {
        history.push(this.buildUrl('.'));
    }

    static navigateTo(path) {
        history.push(path);
    }

    static replaceWith(path) {
        history.replace(path);
    }

    static refresh() {
        let path = cleanPath(history.location.pathname);
        AppRouter.instance.router.emit(path);
    }

    static get currentPath() {
        return cleanPath(history.location.pathname);
    }

    static get currentRoute() {
        return AppRouter.instance.state.currentRoute;
    }

    static buildUrl(path) {
        if(path === '.') {
            // go to parent path
            let lastSlashIndex = AppRouter.currentPath.lastIndexOf('/');
            path = AppRouter.currentPath.substring(0, lastSlashIndex);
        }

        let tokens = path.split('?');
        let pathOnly = tokens[0];
        let paramsOnly = tokens[1];

        // recall query params from last time the target route was visited
        // if the path also contains query params, these should override
        // any recalled params
        let route = AppRouter.instance.router.match(pathOnly);
        let savedParams = route && AppRouter.queryParams[route];
        if(savedParams) {
            // create new params object from query string in path
            let params = new URLSearchParams(paramsOnly);

            // recall saved params
            Array.from(savedParams.keys()).forEach(key => {
                if(!params.get(key)) { // dont replace if already set
                    let val = savedParams.get(key);
                    params.set(key, val);
                }
            });
            let queryString = params.toString();
            if(queryString) {
                return `${pathOnly}?${queryString}`;
            }
        }
        return path;
    }

    static getQueryParam(key) {
        let params = new URLSearchParams(window.location.search);
        return params.get(key);
    }

    static setQueryParam(key, val) {
        let params = new URLSearchParams(window.location.search);
        params.set(key, val);

        // keep track of query params by route
        AppRouter.queryParams[AppRouter.currentRoute] = params;

        let query = params.toString();
        history.replace(`?${query}`);
    }

    static deleteQueryParam(key) {
        let params = new URLSearchParams(window.location.search);
        params.delete(key);
        let query = params.toString();
        history.replace(`?${query}`);
    }

    /**
     * Render the next child route of the current route
     * If no child exists, then returns null
     */
    static outlet(routeInfo) {
        let stack = AppRouter.instance.state.routeStack;
        let index = stack.indexOf(routeInfo);
        if(index === -1) {
            throw new Error('RouteInfo provided was not found in the current stack.');
        }
        let childRouteInfo = stack[index + 1];
        return AppRouter.instance.renderRoute(childRouteInfo);
    }

    // expose Evented on/off as static functions
    // this is a little hacky - could probably be done better
    static on = (...args) => _evented.on(...args);
    static off = (...args) => _evented.off(...args);
}

// The URL is the source of truth for this routing pattern
// Whenever the URL changes, this function will look to see if
// we need to perform a transition and notify the AppRouter instance
let lastPathnameProcessed = history.location.pathname;
history.listen((location) => {
    if(AppRouter.instance && lastPathnameProcessed !== location.pathname) {
        // give event listeners a chance to cancel the transition
        // return false or Promise(false) from willTransition handlers to abort
        let promises = _evented
            .trigger('willTransition', location)
            .map(r => Promise.resolve(r)); // cast results as promises

        Promise.all(promises)
            .then(results => {
                if(results.contains(false)) {
                    // abort transition
                    history.goBack();
                    return;
                }

                lastPathnameProcessed = location.pathname;
                let path = cleanPath(location.pathname);
                AppRouter.instance.router.emit(path);
            });
    }
});

function compareParams(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

function cleanPath(path) {
    // strip trailing slash
    let cleaned = path.endsWith('/') ?
        path.substring(0, path.length - 1) :
        path;

    return cleaned;
}
