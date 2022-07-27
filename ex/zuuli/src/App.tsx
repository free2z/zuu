import React from "react"
import { Outlet } from "react-router-dom"

import { Grid } from "@mui/material"

import TopBar from "./components/TopBar"
import BottomNav from "./components/BottomNav"


export default function App() {

  return (
    <Grid container
      // xs={12} sm={11} md={10} lg={8} xl={7}
      style={{ margin: "0 auto" }}
    >
      <TopBar />
      <Grid
        item xs={12}
        style={{
          width: "100%",
          padding: "0.5em",
          wordWrap: "break-word",
          // maxHeight: "90vh",
          // minHeight: "70vh",
          // TODO: make more perfect
          // do some math?
          paddingTop: "70px",
          paddingBottom: "70px",
          minHeight: "100vh",
        }}
      >
        <Outlet />
      </Grid>
      <BottomNav />
    </Grid >
  )
}
