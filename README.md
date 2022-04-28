# React App Router
A static router for react web apps. Yes there are other routers available. This one supports some things others don't such as

* Static routing definition so you can see your entire route structure in one place
* Nested routes with `fetchData` hooks at each level

## Usage

Create a file in your root directory called `RouteConfig.js`. This is imported by AppRouter.js and sets up your routing structure.

```javascript
// import Components that represent your routes/pages
import HomeRoute from "./routes/HomeRoute";
import CustomerRoute from "./routes/CustomerRoute";
import CustomerOrderRoute from "./routes/CustomerOrderRoute";
import LoginRoute from "./routes/LoginRoute";
import NotFoundErrorScreen from "./components/NotFoundErrorScreen";

export default ([
    {
        path: '/',
        component: HomeRoute,
    },
    {
        path: '/login',
        component: LoginRoute,
    },
    {
        path: '/customers/:customerId',
        component: CustomerRoute,
        paramTypes: {
            customerId: 'number',
        },
        // this route has sub-routes
        routes: [
            {
                path: '/order',
                paramTypes: {
                    orderId: 'number',
                },
                component: CustomerOrderRoute,
            },
        ]
    },
    {
        path: '/404',
        component: NotFoundErrorScreen,
    },
]);
```

## Route Components
Each route component used in the RouterCofig can implement a function to load data as you transition to the route. This function has one parameter which is the params passed in from the router

```javascript
static fetchData(props) {
  return fetch(`api/customer/${props.customerId}`);
}
```
The result of this function is then available to the component in the property `props.routeInfo.data` (see below)

## RouteInfo
The route component will have access to routing information via `props.routeInfo`. The structure of this is as follows:
```javascript
routeInfo: {
  route: object // the route definition
  params: object // a hash of any router params from the url
  data: object // any data returned from `fetchData`
  
}
```

## Nested Routes
When a route is configured with 1 or more sub-routes, call `AppRouter.outlet(this.props.routeInfo)` in the render method of the parent route to output the children. If no child route is currently active this call will return null, allowing you to display index content in it's place.
```javascript
render() {
    return (
      <>
        <h1>Customer</h1>
        {AppRouter.outlet(this.props.routeInfo) || (
          // if a child route is active the outlet will render content
          // otherwise put your index content here
        )}
      </>
    );
}
```

